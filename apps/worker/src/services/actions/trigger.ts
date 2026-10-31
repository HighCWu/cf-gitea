/**
 * The Actions trigger chain — SPEC-0012 M3 tier P (the §D5 decomposition's
 * PURE-PARITY rows) + the E-tier call-sites (§D5 E2 run-name, E3 the job
 * `if:` gate, E4 the workflow-level concurrency gate at run creation, and
 * the run-index counter CAS), over the landed evaluator tiers S
 * (expression-syntax) and E (expression-eval). Ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef.
 *
 * ## The trigger flow map (upstream cites → this module)
 *
 *   engine onPush seam (packages/git-engine mod.ts:1043-1052, wired
 *   src/index.ts `onPush`) → `handleActionsPushEvent` (the
 *   services/actions/notifier.go:541-644 push/create/delete hooks over our
 *   applied-updates delta) → the notify posture (`notify`,
 *   services/actions/notifier_helper.go:136-296: cycle break :139-155,
 *   empty/archived/unit skips :153-166, default-branch fallback :174-185) →
 *   `skipWorkflows` [skip ci] (:298-340; strings modules/setting/actions.go:51)
 *   → `detectWorkflows` (modules/actions/workflows.go:180-240: enumeration
 *   :75-121, event extraction :123-137, matching :288-388) →
 *   `insertTriggeredRun` (services/actions/run.go:63-217: run index :67 via
 *   the repo_counters.run_index CAS, run-name interpolation :120-134 through
 *   the E-tier evaluator, workflow-level concurrency :83-115, per-job payload
 *   split, decideJobIf :246, waiting/pending statuses :217-231, the
 *   task-version bump :159-165) → commit statuses
 *   (services/actions/commit_status.go:31-63 + the skipped-status arm :218-297)
 *   → the needs-graph emitter pass (services/actions/job_emitter.go's
 *   checkJobsOfCurrentRunAttempt :93-201 + jobStatusResolver :444-548, the
 *   evaluateJobIf gate :589-596, the implicit-success skip arm
 *   services/actions/helper.go:158-160) — and the claim-payload `if: always()`
 *   rewrite (services/actions/task.go:176-186) served by dispatch at claim
 *   time.
 *
 * ## The staged boundary (per §D5's staging sentence, narrowed by the E wave)
 *
 *   - The insert gate is now MATRIX-SHAPED, not the P-tier `${{` byte scan:
 *     a workflow whose jobs carry `strategy.matrix` inserts NO run (the E5
 *     expansion arm — static combos jobparser.go:112-126 and the deferred
 *     emitter expansion matrix.go:43-204 — needs the YAML workflow model
 *     port: actionslib pkg/model + in-tree jobparser's Job/Strategy decode,
 *     Strategy.resolve, MatrixCombinations/buildMatrixCombos, plus
 *     expreval's EvaluateYamlNode (evaluator.go:96-260) — the exact seam the
 *     landed expression-eval records in its evaluator.ts header. Recorded as
 *     exactly-what-is-missing; never half-wired). All other expression
 *     surfaces now flow: run-name, job `if:`, workflow-level concurrency are
 *     evaluated server-side; step-level `${{` rides the payload verbatim
 *     (runner-side upstream too — §D3).
 *   - The E2 combo-interpolation surfaces (combo name:/runs-on:/
 *     continue-on-error, jobparser.go:225-297) stage WITH the matrix model:
 *     a non-matrix job whose name/runs-on/continue-on-error carries `${{`
 *     inserts with the RAW string (documented divergence; upstream
 *     interpolates through the combo evaluator). Job `if:` and run-name are
 *     evaluated — see above.
 *   - The job-level concurrency gate (§D2 #5-6: EvaluateJobConcurrencyFillModel
 *     at insertRunJob run.go:250-280 + updateConcurrencyEvaluationForJobWithNeeds
 *     job_emitter.go:684-702) stages with the matrix model too: its
 *     newJobEvaluator (model.go:297-303) reads the parsed combo's
 *     strategy+matrix. The RAW node is stored (job.RawConcurrency parity,
 *     run.go:251-256) with is_concurrency_evaluated = false; v1 rows never
 *     gate on it.
 *   - The S-tier seam is WIRED: the detection loop runs the landed
 *     `expression-syntax` wrapper's static scan (validate.go:47-62's two
 *     context arms — the YAML-model half of ValidateWorkflowStatic, :22-46,
 *     stages with the E-tier model port) and a context violation feeds the
 *     landed `invalid-workflow` failed-run arm (invalid_workflow.go:20-45,
 *     gated notifier_helper.go:284-286, disabled-skip inside). A workflow
 *     whose `on:` node fails to parse stays on the log-and-skip arm —
 *     upstream's NON-static classification (workflows.go:202-207), never a
 *     failed run.
 *   - Schedules (`on: schedule`) parse but produce nothing — SPEC §1.4 defers
 *     the schedule machinery (services/actions/schedule_tasks.go).
 *   - The notifier census hooks beyond the push/create/delete family (issues,
 *     PRs, releases, packages, wikis, migrations/automerge —
 *     services/actions/notifier.go:41-784, 35 hooks) are pinned, not wired:
 *     their producer events ride seams this unit does not own. The P-tier
 *     wiring here is the push family — the trigger chain's entry seam.
 *
 * ## The platform adaptations (each upstream-sanctioned or forced)
 *
 *   - Run numbering: upstream's `action_run_index` named sequence via
 *     GetNextResourceIndex (models/db/index.go:115-168) maps to
 *     `repo_counters.run_index` (SPEC §4.5): nextRunIndex allocates in one
 *     atomic D1 batch (bootstrap-at-max → never-rewind repair → bump+read),
 *     mirroring issues/service.ts's §3.1 counter idiom. The two max+1
 *     writers outside this counter (invalid-workflow runs, repo-actions
 *     routes) keep UNIQUE(repo_id, index) as their backstop. Upstream's
 *     insert-transaction rollback on a parse/eval failure is reproduced by a
 *     compensating delete + a guarded counter decrement.
 *   - Payload bytes: re-serialized with the `yaml` package (block style,
 *     never-wrapped lines — upstream's marshalYAML discipline,
 *     jobparser/model.go:117-120), not go.yaml's byte layout. The runner
 *     parses YAML; byte identity is not load-bearing.
 *   - The commit-status dedupe uses `context` directly (the landed
 *     commit_statuses table has no context_hash/index columns — the same
 *     reduction api/services/commit-status.ts:22-30 records); the
 *     legacy-hash adoption arm (commit_status.go:292-302) is unreachable here.
 *   - Per-isolate emitter: upstream drives checkJobsByRunID through its
 *     `actions_ready_job` queue (job_emitter.go:29-41); the pass runs inline
 *     and the producer call sites (insert tail, update.ts's aggregate seam —
 *     its module header names the anchor) call it directly. The concurrency
 *     cancel arm settles affected runs the same way (notifyAndEmitFinishedJobs,
 *     run.go:155-160, through our emitter pass).
 *   - github.ref_protected: branches resolve through the landed
 *     branch-protection store (findRule ≈ IsBranchProtected); protected TAGS
 *     have no cf-gitea store (SPEC-0013 landed branches only) → false, the
 *     upstream IsRefProtected tag arm (models/git/ref.go:22-28) without a
 *     table is recorded as the store-gap divergence.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { parseDocument, Document, YAMLMap, isMap, isScalar, isSeq, type Node as YamlNode } from "yaml";

import {
  actionRunAttempts,
  actionRunJobs,
  actionRunJobSummaries,
  actionRuns,
  actionTaskOutputs,
  actionVariables,
  commitStatuses,
  repoCounters,
  repoUnits,
  repositories,
  users,
} from "../../db/schema";
import { findRepositoryByPath, type RepositoryWithOwner } from "../../api/services/repository";
import { engineName } from "../../repos/service";
import { findRule, listRepoRules, parseRuleConfig, type ProtectedBranchRow } from "../branch-protection";
import { loadRepoActionsConfig } from "./config";
import {
  DefaultStatusCheck,
  NewEvaluator,
  newServerInterpeter,
  type Evaluator,
  type ServerJobResult,
} from "./expression-eval";
import { jobConditionContexts, unavailableContext, validateStaticExpressions } from "./expression-syntax";
import { handleInvalidWorkflows, type InvalidWorkflowParseError } from "./invalid-workflow";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_PENDING,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  increaseTaskVersion,
  ellipsisDisplayString,
  type RunJobRow,
  type RunRow,
} from "./model";
import { refreshRunStatus, stopTask } from "./update";

/** The bindings/vars the trigger touches (webhooks-push.ts's picked-Env rule). */
export interface ActionsTriggerEnv extends Pick<Env, "DB" | "REPO"> {
  /** Upstream `setting.AppURL` — the commit-status target-URL base and the
   *  push payload's compare_url base; unset → the receive's origin (the
   *  appOrigin chain, webhooks-push.ts:236-238). */
  APP_URL?: string;
}

// ---------------------------------------------------------------------------
// Settings (modules/setting/actions.go:49-59)
// ---------------------------------------------------------------------------

/** SkipWorkflowStrings (actions.go:51) — the [skip ci] family. */
export const SKIP_WORKFLOW_STRINGS: readonly string[] = [
  "[skip ci]",
  "[ci skip]",
  "[no ci]",
  "[skip actions]",
  "[actions skip]",
];

/** WorkflowDirs (actions.go:52). */
export const WORKFLOW_DIRS: readonly string[] = [".gitea/workflows", ".github/workflows"];

/** GetContentFromEntry's 1 MiB per-file cap (workflows.go:110-121,
 *  util.ReadWithLimit 1024*1024). */
export const WORKFLOW_FILE_MAX_BYTES = 1024 * 1024;

/** MaxJobNumPerRun (models/actions/run_job.go:29) — the matrix ceiling the
 *  E-tier expansions respect; pinned here because the payload-split cap
 *  derives from it. */
export const MAX_JOB_NUM_PER_RUN = 256;

/** Upstream `setting.UI.FeedMaxCommitNum` — the push payload's commit cap
 *  (push.go:189-191 truncates before notify). */
const FEED_MAX_COMMIT_NUM = 5; // webhooks-push.ts's landed constant (the repo's pinned value)

// ---------------------------------------------------------------------------
// The glob compiler (modules/glob/glob.go — byte-exact port)
// ---------------------------------------------------------------------------

interface GlobCompilerOptions {
  /** `?` stays a literal regexp quantifier instead of [^sep] (CompileWorkflow). */
  regexpQuestion: boolean;
  /** `+` stays a literal regexp quantifier (CompileWorkflow). */
  regexpPlus: boolean;
  /** A double-star followed by a slash also consumes the right separator
   *  when preceded by it or at the pattern start (CompileWorkflow). */
  superWildcardRight: boolean;
  /** A leading `!` inverts every Match result (CompileWorkflow). */
  supportNegative: boolean;
}

export interface Glob {
  match(s: string): boolean;
}

/**
 * initGlobCompiler (glob.go:152-185) over JS RegExp. Go's regexp and JS
 * RegExp agree on every construct the compiler emits (classes, `.*`,
 * escaping); the anchors make Go's unanchored MatchString a full match.
 */
export function compileGlob(pattern: string, separators: readonly string[], opts: GlobCompilerOptions): Glob {
  const chars = Array.from(pattern);
  const sepSet = new Set(separators);
  const escapedSeparators = separators.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  const nonSeparatorChars = escapedSeparators !== "" ? `[^${escapedSeparators}]` : ".";

  let negativeFlip = false;
  let pos = 0;
  if (opts.supportNegative && chars.length > 0 && chars[0] === "!") {
    negativeFlip = true;
    pos = 1;
  }

  let body = "";
  const compile = (subPattern: boolean): void => {
    while (pos < chars.length) {
      const c = chars[pos];
      pos += 1;
      if (subPattern && c === "}") {
        body += ")";
        return;
      }
      switch (c) {
        case "*": {
          if (pos < chars.length && chars[pos] === "*") {
            let matchRightSep = false;
            if (opts.superWildcardRight) {
              const rightRune = pos + 1 < chars.length ? (chars[pos + 1] ?? "") : "";
              if (rightRune !== "" && sepSet.has(rightRune)) {
                matchRightSep = pos - 2 < 0 || chars[pos - 2] === rightRune;
              }
            }
            pos += matchRightSep ? 2 : 1;
            body += ".*";
          } else {
            body += `${nonSeparatorChars}*`;
          }
          break;
        }
        case "?":
          body += opts.regexpQuestion ? "?" : nonSeparatorChars;
          break;
        case "+":
          body += opts.regexpPlus ? "+" : `\\+`;
          break;
        case "[": {
          // compileChars (glob.go:39-68)
          body += "[";
          if (pos < chars.length && chars[pos] === "!") {
            pos += 1;
            body += "^";
          }
          let closed = false;
          while (pos < chars.length) {
            const cc = chars[pos];
            pos += 1;
            if (cc === "]") {
              body += "]";
              closed = true;
              break;
            }
            if (cc === "\\") {
              if (pos >= chars.length) {
                throw new Error("unterminated character class escape");
              }
              body += `\\${chars[pos]}`;
              pos += 1;
            } else {
              // A literal `]` that is NOT the closer cannot be expressed in a
              // JS class without breaking it; escape it (Go's regexp tolerates
              // a bare `]` inside a class, JS requires the escape — same set).
              body += cc === "]" ? "\\]" : cc;
            }
          }
          if (!closed) {
            throw new Error("unterminated character class");
          }
          break;
        }
        case "{":
          body += "(";
          compile(true);
          break;
        case ",":
          body += subPattern ? "|" : ",";
          break;
        case "\\": {
          if (pos >= chars.length) {
            throw new Error("no character to escape");
          }
          body += `\\${chars[pos]}`;
          pos += 1;
          break;
        }
        case ".":
        case "^":
        case "$":
        case "(":
        case ")":
        case "|":
          body += `\\${c}`;
          break;
        default:
          body += c;
      }
    }
  };

  body = "^";
  compile(false);
  body += "$";
  const re = new RegExp(body);
  return {
    match(s: string): boolean {
      const ret = re.test(s);
      return negativeFlip ? !ret : ret;
    },
  };
}

/** Compile (glob.go:195-197) — activity-type patterns (matchActivityType,
 *  workflows.go:898-905, separators `/`). */
export function compileActivityGlob(pattern: string): Glob {
  return compileGlob(pattern, ["/"], {
    regexpQuestion: false,
    regexpPlus: false,
    superWildcardRight: false,
    supportNegative: false,
  });
}

/** CompileWorkflow (glob.go:199-206) — the branches/tags/paths/workflows
 *  filter patterns. */
export function compileWorkflowGlob(pattern: string): Glob {
  return compileGlob(pattern, ["/"], {
    regexpQuestion: true,
    regexpPlus: true,
    superWildcardRight: true,
    supportNegative: true,
  });
}

// ---------------------------------------------------------------------------
// workflowpattern (modules/actions/workflowpattern/workflow_pattern.go)
// ---------------------------------------------------------------------------

export interface WorkflowPattern {
  negative: boolean;
  glob: Glob;
}

/** CompilePatterns (workflow_pattern.go:17-27). */
export function compilePatterns(...patterns: string[]): WorkflowPattern[] {
  return patterns.map((pattern) => ({
    glob: compileWorkflowGlob(pattern),
    negative: pattern.startsWith("!"),
  }));
}

/**
 * Skip (workflow_pattern.go:30-49) — paths/branches semantics: a workflow
 * matches unless EVERY input is skipped (a negative pattern only re-skips a
 * file the positive patterns had unskipped).
 */
export function skipPatterns(sequence: WorkflowPattern[], input: string[]): boolean {
  let allSkipped = true;
  for (const file of input) {
    let shouldSkip = true;
    for (const item of sequence) {
      if (item.negative) {
        // "!README.md" doesn't match "README.md", so "README.md" should be skipped
        if (!item.glob.match(file)) {
          shouldSkip = true;
        }
      } else if (item.glob.match(file)) {
        // if "*.md" matches "help.md" so it shouldn't be skipped
        shouldSkip = false;
      }
    }
    allSkipped = allSkipped && shouldSkip;
  }
  return sequence.length > 0 && allSkipped;
}

/** Filter (workflow_pattern.go:52-65) — paths-ignore/branches-ignore: skip
 *  when EVERY input matches (an input matching nothing un-skips). */
export function filterPatterns(sequence: WorkflowPattern[], input: string[]): boolean {
  for (const file of input) {
    let anyMatched = false;
    for (const item of sequence) {
      anyMatched = item.glob.match(file);
      if (anyMatched) break;
    }
    if (!anyMatched) {
      return false;
    }
  }
  return sequence.length !== 0;
}

/** matchActivityType (workflows.go:897-905): an invalid pattern is no match
 *  (the compile cannot fail for JS RegExp — the error arm is unreachable). */
export function matchActivityType(pattern: string, actions: string[]): boolean {
  const g = compileActivityGlob(pattern);
  return actions.some((a) => g.match(a));
}

// ---------------------------------------------------------------------------
// Event extraction (jobparser.ParseRawOn, model.go:321-…)
// ---------------------------------------------------------------------------

/** jobparser.Event (model.go:274-281) — acts read verbatim; the `on:`
 *  filters are never expression-evaluated server-side (the matchers compile
 *  the raw strings). */
export interface WorkflowEvent {
  name: string;
  /** The mapping form's filters (`branches`, `types`, …), upstream's acts. */
  acts: Record<string, string[]>;
  /** The schedule arm's cron entries (model.go:282 — IsSchedule); staged,
   *  §1.4. */
  schedules: Array<Record<string, string>> | null;
}

/** workflowCallEvent (model.go:319) — excluded from trigger detection. */
const WORKFLOW_CALL_EVENT = "workflow_call";

/** A mapping node's value for a key, kept as a node (undefined absent). */
function mapGet(map: YAMLMap, key: string): YamlNode | undefined {
  return map.get(key, true);
}

/** A scalar node's JS value, or undefined for anything else. */
function scalarValue(node: YamlNode | undefined): unknown {
  return isScalar(node) ? node.value : undefined;
}

/** A mapping node's scalar key text. */
function keyText(node: YamlNode | undefined): string {
  const v = scalarValue(node);
  return typeof v === "string" ? v : "";
}

/** Decodes a scalar-or-sequence of strings (upstream's two Decode arms). */
function stringList(node: YamlNode): string[] {
  const v = scalarValue(node);
  if (typeof v === "string") return [v];
  if (isSeq(node)) {
    return node.items.map((item) => {
      const iv = scalarValue(item as YamlNode);
      if (typeof iv !== "string") throw new Error("unknown on type");
      return iv;
    });
  }
  throw new Error("unknown on type");
}

/**
 * ParseRawOn (model.go:321-…): the three `on:` shapes. Returns [] when the
 * only event is workflow_call (upstream's empty result).
 */
export function parseRawOn(rawOn: YamlNode): WorkflowEvent[] {
  // ScalarNode: `on: push`
  if (isScalar(rawOn)) {
    const val = typeof rawOn.value === "string" ? rawOn.value : "";
    if (val === "") throw new Error(`invalid event "${val}"`);
    if (val === WORKFLOW_CALL_EVENT) return [];
    return [{ name: val, acts: {}, schedules: null }];
  }
  // SequenceNode: `on: [push, pull_request]`
  if (isSeq(rawOn)) {
    const res: WorkflowEvent[] = [];
    for (const item of rawOn.items) {
      const v = scalarValue(item as YamlNode);
      if (typeof v !== "string") throw new Error("invalid type");
      if (v === WORKFLOW_CALL_EVENT) continue;
      res.push({ name: v, acts: {}, schedules: null });
    }
    return res;
  }
  // MappingNode: `on: {push: {branches: [main]}}`
  if (isMap(rawOn)) {
    const res: WorkflowEvent[] = [];
    for (const pair of rawOn.items) {
      const k = keyText(pair.key as YamlNode | undefined);
      if (k === WORKFLOW_CALL_EVENT) continue;
      const v = pair.value as YamlNode;
      if (isScalar(v)) {
        res.push({ name: k, acts: {}, schedules: null });
      } else if (isSeq(v)) {
        const entries = v.items;
        if (k === "schedule") {
          if (entries.length === 0) throw new Error("schedule must contain at least one cron entry");
          const schedules = entries.map((entry) => {
            if (!isMap(entry)) throw new Error("unknown on type(schedule)");
            const record: Record<string, string> = {};
            for (const p of entry.items) {
              const pk = keyText(p.key as YamlNode | undefined);
              const pv = scalarValue(p.value as YamlNode | undefined);
              if (typeof pv !== "string") throw new Error("unknown on type(schedule)");
              record[pk] = pv;
            }
            return record;
          });
          // Upstream validates each cron with cron.ParseStandard here; the
          // schedule MACHINERY is §1.4-staged, so the entries parse but no
          // validator runs (a staged row's reduction, disclosed).
          res.push({ name: k, acts: {}, schedules });
        } else {
          res.push({ name: k, acts: {}, schedules: null });
        }
      } else if (isMap(v)) {
        const acts: Record<string, string[]> = {};
        for (const p of v.items) {
          const act = keyText(p.key as YamlNode | undefined);
          const val = p.value as YamlNode;
          if (isMap(val)) {
            // upstream: map only for workflow_dispatch inputs (model.go) —
            // inputs decode and store nothing in acts
            if (k !== "workflow_dispatch" || act !== "inputs") {
              throw new Error(`map should only for workflow_dispatch but ${act}`);
            }
          } else {
            acts[act] = stringList(val);
          }
        }
        const hasActs = Object.keys(acts).length > 0;
        res.push({ name: k, acts: hasActs ? acts : {}, schedules: null });
      } else {
        throw new Error("unknown on type");
      }
    }
    return res;
  }
  throw new Error("unknown on type");
}

/** GetEventsFromContent (workflows.go:123-126) — the `on:` node read only. */
export function getEventsFromContent(content: string): WorkflowEvent[] {
  const doc = parseDocument(content);
  const on = doc.get("on", true) as YamlNode | undefined;
  if (on === undefined) {
    return [];
  }
  return parseRawOn(on);
}

/**
 * The static scan's expression extraction — the YAML read of the two surfaces
 * upstream's ValidateWorkflowStatic scans (validate.go:45-51's run-name header
 * and validateJobConditions' per-job `if:`, validate.go:54-62): the run-name
 * scalar ("" when absent) and each job's raw `if:` value. Structural
 * validation (the YAML-model half, validate.go:22-46) stages with the E-tier
 * model port; a shape this reader cannot extract falls to the caller's
 * non-static log-and-skip arm.
 */
function staticExpressionsOf(content: string): { runName: string; jobIfs: Record<string, string> } {
  const doc = parseDocument(content);
  const runNameValue = scalarValue(doc.get("run-name", true) as YamlNode | undefined);
  const runName = typeof runNameValue === "string" ? runNameValue : "";
  const jobIfs: Record<string, string> = {};
  const jobs = doc.get("jobs", true) as YamlNode | undefined;
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      const jobId = keyText(pair.key as YamlNode | undefined);
      const jobNode = pair.value as YamlNode;
      if (!isMap(jobNode)) continue;
      const v = scalarValue(mapGet(jobNode, "if"));
      if (typeof v === "string") jobIfs[jobId] = v;
      else if (typeof v === "boolean") jobIfs[jobId] = v ? "true" : "false";
    }
  }
  return { runName, jobIfs };
}

// ---------------------------------------------------------------------------
// Workflow enumeration (workflows.go:53-121)
// ---------------------------------------------------------------------------

/** isWorkflowInDirs (workflows.go:62-73): .yml/.yaml under one of the dirs. */
export function isWorkflowPath(path: string): boolean {
  if (!path.endsWith(".yaml") && !path.endsWith(".yml")) {
    return false;
  }
  return WORKFLOW_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

export interface WorkflowFile {
  /** The tree path (upstream entry.Name() is the full path below the repo root). */
  entryName: string;
  content: string;
}

export interface WorkflowTreeReads {
  /** The cell's one-level listing; null = the path does not exist. */
  listTree(ref: string, path: string): Promise<{ entries: Array<{ name: string; type: "tree" | "blob" | "commit" }> } | null>;
  readBlob(ref: string, path: string): Promise<{ data: Uint8Array } | null>;
}

/**
 * listWorkflowsInDirs (workflows.go:79-108): the FIRST dir of WORKFLOW_DIRS
 * that exists wins entirely (the loop breaks on the first SubTree success —
 * both dirs are never merged), then the recursive .yml/.yaml listing.
 * The recursive walk rides repeated listTree calls (upstream's
 * ListEntriesRecursiveFast).
 */
export async function listWorkflows(reads: WorkflowTreeReads, ref: string): Promise<WorkflowFile[]> {
  let base: string | null = null;
  for (const dir of WORKFLOW_DIRS) {
    const tree = await reads.listTree(ref, dir);
    if (tree !== null) {
      base = dir;
      break;
    }
  }
  if (base === null) {
    return [];
  }
  const files: string[] = [];
  const walk = async (prefix: string, depthBudget: number): Promise<void> => {
    if (depthBudget <= 0) return; // pathological nesting guard (upstream's walk is depth-unbounded; the budget only stops cycles)
    const tree = await reads.listTree(ref, prefix);
    if (tree === null) return;
    for (const entry of tree.entries) {
      const path = `${prefix}/${entry.name}`;
      if (entry.type === "tree") {
        await walk(path, depthBudget - 1);
      } else if (path.endsWith(".yml") || path.endsWith(".yaml")) {
        files.push(path);
      }
    }
  };
  await walk(base, 16);
  const out: WorkflowFile[] = [];
  for (const entryName of files) {
    const blob = await reads.readBlob(ref, entryName);
    if (blob === null) continue;
    // GetContentFromEntry's cap (workflows.go:110-121): ReadWithLimit errors
    // past 1 MiB — an oversized file is dropped, never truncated.
    if (blob.data.byteLength > WORKFLOW_FILE_MAX_BYTES) {
      continue;
    }
    out.push({ entryName, content: new TextDecoder().decode(blob.data) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// readWorkflowEvents — the P gate (workflows.go:128-137)
// ---------------------------------------------------------------------------

/**
 * The `${{` byte scan (workflows.go:134's hasExpression classification arm,
 * also jobparser.go:28's hasExpression behind IfExpression). The P-tier
 * used it as the insert gate; the E wave narrows that gate to matrix-bearing
 * content (module header) — the scan itself stays for the classification
 * surface (and the S-tier arms that read it).
 */
export function containsExpression(content: string): boolean {
  return content.includes("${{");
}

// ---------------------------------------------------------------------------
// Matching (workflows.go:288-505)
// ---------------------------------------------------------------------------

/** The webhook event names the push family feeds (webhook_module). */
export type TriggerEventType = "push" | "create" | "delete";

/**
 * canGithubEventMatch (modules/actions/github.go:72-…) for the wired family:
 * `create`→HookEventCreate, `delete`→HookEventDelete, `push`→HookEventPush.
 * The other github events (issues/PR/release/package/workflow_run …) match
 * only their own triggers — none of which this unit's producer feeds; the
 * census cites live in the module header.
 */
export function canGithubEventMatch(eventName: string, triggerEvent: TriggerEventType): boolean {
  switch (eventName) {
    case "push":
      return triggerEvent === "push";
    case "create":
      return triggerEvent === "create";
    case "delete":
      return triggerEvent === "delete";
    default:
      return false;
  }
}

export interface PushPayloadLike {
  ref: string;
  before: string;
  after: string;
}

/** The detect result triple (workflows.go:36-42). */
export type DetectResult = "matched" | "notApplicable" | "filteredOut";

/** matchPushEvent (workflows.go:390-497) — the byte-exact port. */
export function matchPushEvent(pushPayload: PushPayloadLike, evt: WorkflowEvent, filesChanged: string[] | null): DetectResult {
  const acts = Object.entries(evt.acts);
  // with no special filter parameters
  if (acts.length === 0) {
    return "matched";
  }

  let matchTimes = 0;
  let hasBranchFilter = false;
  let hasTagFilter = false;
  const ref = pushPayload.ref;
  const isBranch = ref.startsWith("refs/heads/");
  const isTag = ref.startsWith("refs/tags/");
  const branchName = isBranch ? ref.slice("refs/heads/".length) : "";
  const tagName = isTag ? ref.slice("refs/tags/".length) : "";
  // all acts conditions should be satisfied
  for (const [cond, vals] of acts) {
    switch (cond) {
      case "branches": {
        hasBranchFilter = true;
        if (!isBranch) break;
        let patterns: WorkflowPattern[];
        try {
          patterns = compilePatterns(...vals);
        } catch {
          break;
        }
        if (!skipPatterns(patterns, [branchName])) {
          matchTimes += 1;
        }
        break;
      }
      case "branches-ignore": {
        hasBranchFilter = true;
        if (!isBranch) break;
        let patterns: WorkflowPattern[];
        try {
          patterns = compilePatterns(...vals);
        } catch {
          break;
        }
        if (!filterPatterns(patterns, [branchName])) {
          matchTimes += 1;
        }
        break;
      }
      case "tags": {
        hasTagFilter = true;
        if (!isTag) break;
        let patterns: WorkflowPattern[];
        try {
          patterns = compilePatterns(...vals);
        } catch {
          break;
        }
        if (!skipPatterns(patterns, [tagName])) {
          matchTimes += 1;
        }
        break;
      }
      case "tags-ignore": {
        hasTagFilter = true;
        if (!isTag) break;
        let patterns: WorkflowPattern[];
        try {
          patterns = compilePatterns(...vals);
        } catch {
          break;
        }
        if (!filterPatterns(patterns, [tagName])) {
          matchTimes += 1;
        }
        break;
      }
      case "paths": {
        if (isTag) {
          matchTimes += 1;
          break;
        }
        if (filesChanged === null) {
          // GetFilesChangedSinceCommit error → detectNotApplicable (workflows.go:456-460)
          return "notApplicable";
        }
        let patterns: WorkflowPattern[];
        try {
          patterns = compilePatterns(...vals);
        } catch {
          break;
        }
        if (!skipPatterns(patterns, filesChanged)) {
          matchTimes += 1;
        }
        break;
      }
      case "paths-ignore": {
        if (isTag) {
          matchTimes += 1;
          break;
        }
        if (filesChanged === null) {
          return "notApplicable";
        }
        let patterns: WorkflowPattern[];
        try {
          patterns = compilePatterns(...vals);
        } catch {
          break;
        }
        if (!filterPatterns(patterns, filesChanged)) {
          matchTimes += 1;
        }
        break;
      }
      default:
        // push event unsupported condition
        break;
    }
  }
  // if both branch and tag filter are defined in the workflow only one needs to match
  if (hasBranchFilter && hasTagFilter) {
    matchTimes += 1;
  }
  return matchTimes === acts.length ? "matched" : "filteredOut";
}

/**
 * detectWorkflowMatch (workflows.go:288-388) for the wired family: the
 * create/delete/schedule arm (events with no activity types — "no special
 * filter parameters, just return true if name matched", :294-304) and the
 * push arm (:306-309). `filesChanged` null = the diff walk failed (the push
 * arm's error branch).
 */
export function detectWorkflowMatch(
  inputEvent: TriggerEventType,
  pushPayload: PushPayloadLike | null,
  evt: WorkflowEvent,
  filesChanged: string[] | null,
): DetectResult {
  if (!canGithubEventMatch(evt.name, inputEvent)) {
    return "notApplicable";
  }
  switch (inputEvent) {
    case "create":
    case "delete":
      return "matched";
    case "push":
      if (pushPayload === null) return "notApplicable";
      return matchPushEvent(pushPayload, evt, filesChanged);
  }
}

// ---------------------------------------------------------------------------
// The [skip ci] scan (services/actions/notifier_helper.go:298-340)
// ---------------------------------------------------------------------------

/**
 * skipWorkflows (notifier_helper.go:298-340) for the wired family: push and
 * pull_request(_sync) scan BOTH surfaces upstream names — the PR title
 * (input.PullRequest.Issue.Title, :308-311) and the commit's raw message
 * (:312-316). The push producer here carries only the commit surface (the
 * PR-title surface arms with the PR trigger producer, staged); both scan
 * arms are ported and unit-tested.
 */
export function skipWorkflows(
  event: string,
  commitMessageRaw: string | null,
  pullRequestTitle: string | null,
): boolean {
  const skipWorkflowEvents = ["push", "pull_request", "pull_request_sync"];
  if (skipWorkflowEvents.includes(event)) {
    for (const s of SKIP_WORKFLOW_STRINGS) {
      if (pullRequestTitle !== null && pullRequestTitle.includes(s)) {
        return true;
      }
      if (commitMessageRaw !== null && commitMessageRaw.includes(s)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The payload split (jobparser.Parse's P slice, jobparser.go:69-145)
// ---------------------------------------------------------------------------

/** A split single-job payload (upstream's SingleWorkflow per job). */
export interface SingleJobPayload {
  /** The YAML job key. */
  jobId: string;
  /** The display name (jobparser jobName: the `name:` or the id). */
  name: string;
  needs: string[];
  runsOn: string[];
  /** The literal strategy.max-parallel (parseMaxParallel's int arm). */
  maxParallel: number;
  continueOnError: boolean;
  /** The raw `if:` node text (empty when absent). */
  rawIf: string;
  /** The single-job YAML bytes (WorkflowPayload). */
  payload: Uint8Array;
  /** The workflow's `run-name:` RAW value ("" when absent) — CloneHeader
   *  carries the same value to every SingleWorkflow (jobparser.go:146-154);
   *  the E2 interpolation happens at insert, after run.ID exists (run.go's
   *  own insert-before-parse order, :80-89). */
  runName: string;
  /** The job's `concurrency:` node as stored upstream (run.go:251-256
   *  marshals job.RawConcurrency into the row; "" when absent). UnEvaluated
   *  in v1 — the job-level gate stages with the matrix model (module
   *  header). */
  rawConcurrency: string;
  /** The job carries a `strategy.matrix` node (non-null value) — the staged
   *  E5/model-port insert gate (module header). */
  hasMatrix: boolean;
}

/** NeedsFromNode / RunsOnFromNode (model.Job): scalar or sequence. Only
 *  string scalars count (upstream's Decode into []string errors on other
 *  scalars; the non-string arm yields "" there, "" here). */
function yamlStringList(node: YamlNode | undefined): string[] {
  if (node === undefined) return [];
  const v = scalarValue(node);
  if (typeof v === "string") return [v];
  if (isSeq(node)) {
    return node.items.map((item) => {
      const iv = scalarValue(item as YamlNode);
      return typeof iv === "string" ? iv : "";
    });
  }
  return [];
}

/** parseMaxParallel (services/actions/max_parallel.go:12-18): the literal int
 *  arm; a non-int (expression or junk) on a gated (expression-free) workflow
 *  is junk → warn-unlimited upstream, 0 here. */
function parseMaxParallel(strategyNode: YAMLMap | undefined): number {
  if (strategyNode === undefined) return 0;
  const raw = mapGet(strategyNode, "max-parallel");
  const v = scalarValue(raw);
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, MAX_JOB_NUM_PER_RUN);
}

/** GetContinueOnError (model.go): a literal bool; anything else false. */
function parseContinueOnError(jobMap: YAMLMap): boolean {
  const v = scalarValue(mapGet(jobMap, "continue-on-error"));
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  return false;
}

/**
 * The marshal shape (SingleWorkflow.Marshal, model.go:83-88): the workflow
 * header fields the runner parses, one job, RunName blanked ("already
 * interpolated into the run title"). Needs are ERASED from the payload
 * (insertRunJob's SetJob(id, job.EraseNeeds()), run.go:195-202) — the Task
 * wire's `needs` field serves them. Never-wrapped lines (marshalYAML's
 * WithLineWidth(-1)).
 */
function marshalSingleJob(doc: Document, jobId: string, jobNode: YAMLMap): Uint8Array {
  const out = new Document();
  const name = doc.get("name", true) as YamlNode | undefined;
  if (name !== undefined) out.set("name", name);
  const on = doc.get("on", true) as YamlNode | undefined;
  if (on !== undefined) out.set("on", on);
  const env = doc.get("env", true) as YamlNode | undefined;
  if (env !== undefined) out.set("env", env);
  const defaults = doc.get("defaults", true) as YamlNode | undefined;
  if (defaults !== undefined) out.set("defaults", defaults);
  const permissions = doc.get("permissions", true) as YamlNode | undefined;
  if (permissions !== undefined) out.set("permissions", permissions);
  const jobs = new YAMLMap();
  jobs.set(jobId, jobNode);
  out.set("jobs", jobs);
  return new TextEncoder().encode(out.toString({ lineWidth: 0 }));
}

/**
 * The jobparser.Parse slice over the workflow: one SingleWorkflow per job,
 * with the workflow's raw run-name and each job's raw concurrency node
 * carried for the insert-time evaluation (the E-tier call-sites; the matrix
 * combo arm still stages — a `strategy.matrix` job is flagged, not expanded).
 * Throws on a malformed jobs mapping (upstream "invalid jobs" → no run).
 */
export function splitWorkflowPayloads(content: string): SingleJobPayload[] {
  const doc = parseDocument(content);
  const jobs = doc.get("jobs", true) as YamlNode | undefined;
  if (jobs === undefined || !isMap(jobs)) {
    throw new Error("invalid jobs");
  }
  // The workflow's run-name RAW value (Parse's workflow.RunName,
  // jobparser.go:103-106 interpolates it with github/vars/inputs only).
  const runNameValue = scalarValue(doc.get("run-name", true) as YamlNode | undefined);
  const runName = typeof runNameValue === "string" ? runNameValue : "";
  const out: SingleJobPayload[] = [];
  for (const pair of jobs.items) {
    const jobId = keyText(pair.key as YamlNode | undefined);
    const jobNode = pair.value as YamlNode;
    if (!isMap(jobNode)) {
      throw new Error("invalid jobs");
    }
    const yamlName = typeof scalarValue(mapGet(jobNode, "name")) === "string" ? String(scalarValue(mapGet(jobNode, "name"))).trim() : "";
    // jobName (jobparser.go): a literal-empty name falls to the job id.
    const displayName = yamlName === "" ? jobId : yamlName;
    // Needs/RunsOn read BEFORE the erase — the payload drops needs
    // (EraseNeeds, run.go:196-201) but the row carries them.
    const needs = yamlStringList(mapGet(jobNode, "needs"));
    const runsOn = yamlStringList(mapGet(jobNode, "runs-on"));
    // The job's concurrency node (run.go:251-256): stored raw, unevaluated
    // (the job-level gate stages with the matrix model — module header).
    const concurrencyNode = mapGet(jobNode, "concurrency");
    const rawConcurrency =
      concurrencyNode !== undefined && (isMap(concurrencyNode) || isScalar(concurrencyNode))
        ? stringifyYamlNode(concurrencyNode)
        : "";
    // The staged E5 gate flag: a non-null strategy.matrix node.
    const strategyNode = mapGet(jobNode, "strategy");
    let hasMatrix = false;
    if (isMap(strategyNode)) {
      const matrixNode = mapGet(strategyNode, "matrix");
      hasMatrix = matrixNode !== undefined && !(isScalar(matrixNode) && matrixNode.value === null);
    }
    // EraseNeeds (run.go:196-201): the payload never carries needs.
    jobNode.delete("needs");
    // The payload's name: carries the resolved display name (buildMatrixCombos'
    // combo.Name = jobName(...); the expression-name interpolation rides the
    // staged combo arm — module header).
    jobNode.set("name", displayName);
    // The raw `if:` text — a bool scalar decodes into the string field as its
    // text (the RawConcurrency contract; `if: false` evaluates false upstream).
    const rawIfNode = mapGet(jobNode, "if");
    const rawIf = isScalar(rawIfNode) && (typeof rawIfNode.value === "string" || typeof rawIfNode.value === "boolean") ? scalarText(rawIfNode) : "";
    out.push({
      jobId,
      name: displayName,
      needs,
      runsOn,
      maxParallel: parseMaxParallel(isMap(strategyNode) ? strategyNode : undefined),
      continueOnError: parseContinueOnError(jobNode),
      rawIf,
      payload: marshalSingleJob(doc, jobId, jobNode),
      runName,
      rawConcurrency,
      hasMatrix,
    });
  }
  return out;
}

/** toYaml via a one-node document (never-wrapped, the marshal discipline). */
function stringifyYamlNode(node: YamlNode): string {
  const doc = new Document();
  doc.contents = node;
  return doc.toString({ lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// The E-tier call-site machinery (SPEC-0012 §D5 E2/E3/E4; the evaluator
// assembly per newServerInterpeter's server shapes — §D2's environment
// table: github/needs/strategy/matrix/vars/inputs, env/steps/runner/secrets
// nil forever, job "" and WorkingDir "" server-side)
// ---------------------------------------------------------------------------

/** IfExpression (jobparser.go:33-38): an `if:` that omits `${{ }}` is
 * evaluated as one expression anyway (github.com's semantics). */
function ifExpression(value: string): string {
  return value.includes("${{") ? value : `${"${{"} ${value} }}`;
}

/** statusNames (models/actions/status.go:29-40) — Status.String(). */
function statusResultString(status: number): string {
  switch (status) {
    case ACTION_STATUS_WAITING:
      return "waiting";
    case ACTION_STATUS_RUNNING:
      return "running";
    case ACTION_STATUS_SUCCESS:
      return "success";
    case ACTION_STATUS_FAILURE:
      return "failure";
    case ACTION_STATUS_CANCELLED:
      return "cancelled";
    case ACTION_STATUS_CANCELLING:
      return "cancelling";
    case ACTION_STATUS_SKIPPED:
      return "skipped";
    case ACTION_STATUS_BLOCKED:
      return "blocked";
    case ACTION_STATUS_PENDING:
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * The github context (GenerateGiteaContext, services/actions/context.go:39-162,
 * ToGitHubContext's GithubContextFromMap projection — the evaluator sees the
 * json-tag fields; `gitea_default_actions_url` has no struct field and never
 * reaches expressions). The PR-payload arm (base_ref/head_ref, the
 * pull_request_target ref/sha swap) is dead in the push family — the producer
 * never carries a pull_request payload. token is deliberately omitted
 * (context.go:332). ref_protected: branches through the landed
 * branch-protection store (findRule ≈ IsBranchProtected, models/git/ref.go:16);
 * tags/others false (no protected-tag store — the module header's
 * store-gap disclosure).
 */
export interface GithubContextInput {
  repoId: string;
  ownerId: number;
  repoOwnerNamespace: string;
  repoSlug: string;
  runId: number;
  runNumber: number;
  /** The attempt number's decimal text (context.go:151-158's precedence —
   *  the insert path passes the freshly created attempt's "1"). */
  runAttempt: string;
  triggerUserId: number;
  ref: string;
  commitSha: string;
  /** run.WorkflowID — the workflow file path. */
  workflowId: string;
  /** run.WorkflowCommitSHA — the commit the workflow content was read at. */
  workflowSha: string;
  /** run.TriggerEvent (event_name). */
  eventName: string;
  eventPayloadJson: string;
  appUrl: string;
}

async function buildGithubContext(d1: D1Database, input: GithubContextInput): Promise<Record<string, unknown>> {
  const userRows = await drizzle(d1)
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, input.triggerUserId))
    .limit(1);
  const actor = userRows[0]?.username ?? "";

  const isBranch = input.ref.startsWith("refs/heads/");
  const isTag = input.ref.startsWith("refs/tags/");
  const refName = isBranch ? input.ref.slice("refs/heads/".length) : isTag ? input.ref.slice("refs/tags/".length) : input.ref;
  const refType = isTag ? "tag" : "branch"; // pull refs report as branches upstream; the push family never sees them
  let refProtected = false;
  if (isBranch) {
    try {
      refProtected = (await findRule(d1, input.repoId, refName)) !== null;
    } catch {
      refProtected = false; // context.go:66-68: a protection-check failure logs and answers false
    }
  }

  let event: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input.eventPayloadJson) as unknown;
    if (parsed !== null && typeof parsed === "object") event = parsed as Record<string, unknown>;
  } catch {
    // an unreadable payload evaluates as the empty object
  }

  const base = input.appUrl.replace(/\/+$/, "");
  const repositoryUrl = `${base}/${input.repoOwnerNamespace}/${input.repoSlug}`;
  return {
    action: "",
    action_path: "",
    action_ref: "",
    action_repository: "",
    action_status: "",
    actor,
    api_url: `${base}/api/v1`,
    base_ref: "",
    env: "",
    event,
    event_name: input.eventName,
    event_path: "",
    graphql_url: "",
    head_ref: "",
    job: "", // context.go:107 — job.JobID when built per job; the if-gate resets it to "" (helper.go:171)
    ref: input.ref,
    ref_name: refName,
    ref_protected: refProtected,
    ref_type: refType,
    path: "",
    repository: `${input.repoOwnerNamespace}/${input.repoSlug}`,
    repository_owner: input.repoOwnerNamespace,
    repositoryUrl,
    retention_days: "", // setting.Actions.ArtifactRetentionDays unset in v1 — the empty-forever arm
    run_id: String(input.runId),
    run_number: String(input.runNumber),
    run_attempt: input.runAttempt,
    secret_source: "Actions",
    server_url: base,
    sha: input.commitSha,
    triggering_actor: actor, // the insert-time attempt's trigger user is the run's (context.go:139-143)
    workflow: input.workflowId,
    workspace: "",
    actor_id: String(input.triggerUserId),
    repository_id: String(input.repoId),
    repository_owner_id: String(input.ownerId),
    workflow_sha: input.workflowSha,
  };
}

/**
 * The call-site evaluator: expreval.New over newServerInterpeter (the server
 * factory — job "", WorkingDir "" so hashFiles self-disables, the §D2
 * contexts). The three wired sites pass NO strategy and NO matrix (run-name:
 * jobparser.go:101's env; job `if:`: model.go:493's nils — "github.com
 * decides before the matrix"; workflow concurrency: concurrency.go:32's nil
 * job) — the combo surfaces stage with the matrix model.
 */
function serverEvaluator(
  githubContext: unknown,
  opts: {
    jobId: string;
    results: Record<string, ServerJobResult>;
    vars: Record<string, string> | undefined;
    inputs: Record<string, unknown> | undefined;
  },
): Evaluator {
  const interpeter = newServerInterpeter({
    jobId: opts.jobId,
    matrix: undefined,
    gitContext: githubContext,
    results: opts.results,
    vars: opts.vars,
    inputs: opts.inputs,
  });
  return NewEvaluator(interpeter);
}

/**
 * GetVariablesOfRun (models/actions/variable.go:134-168): global → owner →
 * repo, later scope wins. The landed dispatch.ts port is claim-shaped; the
 * six-line merge is repeated here rather than claiming a task to read it.
 */
async function loadActionsVariables(d1: D1Database, ownerId: number, repoId: string): Promise<Record<string, string>> {
  const db = drizzle(d1);
  const out: Record<string, string> = {};
  const globalVars = await db.select().from(actionVariables).where(and(eq(actionVariables.ownerId, 0), eq(actionVariables.repoId, "")));
  const ownerVars = await db.select().from(actionVariables).where(and(eq(actionVariables.ownerId, ownerId), eq(actionVariables.repoId, "")));
  const repoVars = await db.select().from(actionVariables).where(and(eq(actionVariables.ownerId, 0), eq(actionVariables.repoId, repoId)));
  for (const v of [...globalVars, ...ownerVars, ...repoVars]) {
    out[v.name] = v.data;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The workflow-level concurrency (§D2 #4 — EvaluateRunConcurrencyFillModel
// concurrency.go:19-44 + the gate, clear_tasks.go:121-150)
// ---------------------------------------------------------------------------

/**
 * RawConcurrency (actionslib pkg/model/workflow.go:1201-1220): `concurrency:`
 * as a bare scalar decodes into RawExpression (UnmarshalYAML tries the string
 * first), as a mapping into group + cancel-in-progress — both strings, a YAML
 * bool arriving as its text (workflow_test.go:380 asserts "true").
 */
export interface RawConcurrency {
  group: string;
  cancelInProgress: string;
  rawExpression: string;
}

/** scalarText: a YAML scalar's Go-text form (a bool node decodes into a
 *  string field as "true"/"false" — the RawConcurrency contract). */
function scalarText(node: YamlNode | undefined): string {
  const v = scalarValue(node);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return "";
}

/** ReadWorkflowRawConcurrency (jobparser/model.go:288-293) minus the full
 *  model validation: the top-level `concurrency:` node read only. The model
 *  port owns the validating shape (module header). */
export function readWorkflowRawConcurrency(content: string): RawConcurrency | null {
  const doc = parseDocument(content);
  const node = doc.get("concurrency", true) as YamlNode | undefined;
  if (node === undefined) return null;
  if (isScalar(node)) {
    return { group: "", cancelInProgress: "", rawExpression: scalarText(node) };
  }
  if (isMap(node)) {
    return {
      group: scalarText(mapGet(node, "group")),
      cancelInProgress: scalarText(mapGet(node, "cancel-in-progress")),
      rawExpression: "",
    };
  }
  return null;
}

/** MarshalYAML (workflow.go:1219-1228): the raw expression as a plain
 *  scalar, else the omitempty mapping in struct field order. This text is
 *  what upstream stores in run.RawConcurrency (run.go:83-89). */
export function marshalRawConcurrency(raw: RawConcurrency): string {
  if (raw.rawExpression !== "") {
    return `${raw.rawExpression}\n`;
  }
  const out: Record<string, string> = {};
  if (raw.group !== "") out["group"] = raw.group;
  if (raw.cancelInProgress !== "") out["cancel-in-progress"] = raw.cancelInProgress;
  const doc = new Document(out);
  return doc.toString({ lineWidth: 0 });
}

/** ParseYamlBool (modules/util/util.go:25-27) — YAML 1.2's true spellings. */
function parseYamlBool(s: string): boolean {
  return s === "true" || s === "True" || s === "TRUE";
}

/** A evaluated scalar's decode-into-string text; composites are the
 *  "failed to unmarshal evaluated concurrency" decode error upstream takes
 *  as an insert abort (model.go:327-330). */
function evaluatedScalarText(evaluator: Evaluator, value: string): string {
  const evaluated = evaluator.evaluateScalar(value);
  if (evaluated.error !== null) {
    throw new Error(`evaluate concurrency: ${evaluated.error.message}`);
  }
  const v = evaluated.value;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (v === undefined || v === null) return "";
  throw new Error("evaluate concurrency: failed to unmarshal evaluated concurrency");
}

/**
 * EvaluateConcurrency's substance for the RUN level (model.go:315-337 over
 * EvaluateRunConcurrencyFillModel's env, concurrency.go:32-35: jobID "",
 * job nil → no strategy/matrix, needs = the empty {"": {}} result set). The
 * YAML-node walker (EvaluateYamlNode) is the staged model seam — the string
 * level is its exact equivalent on the two-scalar RawConcurrency shape.
 * Errors throw: upstream's fill-model failure aborts InsertRun (run.go:100-104).
 */
export function evaluateRunConcurrency(
  githubContext: unknown,
  raw: RawConcurrency,
  vars: Record<string, string>,
): { group: string; cancel: boolean } {
  const evaluator = serverEvaluator(githubContext, { jobId: "", results: { "": {} }, vars, inputs: undefined });
  if (raw.rawExpression !== "") {
    // the whole value evaluates, then re-decodes as the RawExpression arm
    // (UnmarshalYAML tries the string first) → group, no cancel
    return { group: evaluatedScalarText(evaluator, raw.rawExpression), cancel: false };
  }
  const group = evaluatedScalarText(evaluator, raw.group);
  return { group, cancel: parseYamlBool(evaluatedScalarText(evaluator, raw.cancelInProgress)) };
}

interface ConcurrencyAttemptScope {
  repoId: string;
  runId: number;
  runAttemptId: number;
  concurrencyGroup: string;
  concurrencyCancel: boolean;
}

/** GetConcurrencyHolders (models/actions/run.go:375-378): the group's
 *  entries that passed the gate and are not done — waiting/running/
 *  cancelling; a reusable caller's expanded-blocked form is v1-dead. */
async function getConcurrencyHolders(
  d1: D1Database,
  repoId: string,
  group: string,
): Promise<{ attempts: Array<{ id: number; runId: number }>; jobs: RunJobRow[] }> {
  const db = drizzle(d1);
  const holding = [ACTION_STATUS_WAITING, ACTION_STATUS_RUNNING, ACTION_STATUS_CANCELLING];
  const attempts = await db
    .select({ id: actionRunAttempts.id, runId: actionRunAttempts.runId })
    .from(actionRunAttempts)
    .where(and(eq(actionRunAttempts.repoId, repoId), eq(actionRunAttempts.concurrencyGroup, group), inArray(actionRunAttempts.status, holding)));
  const jobs = await db
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.repoId, repoId), eq(actionRunJobs.concurrencyGroup, group), inArray(actionRunJobs.status, holding)));
  return { attempts, jobs };
}

/** GetConcurrencyWaiters (run.go:381-384): the group's blocked entries. */
async function getConcurrencyWaiters(
  d1: D1Database,
  repoId: string,
  group: string,
): Promise<{ attempts: Array<{ id: number; runId: number }>; jobs: RunJobRow[] }> {
  const db = drizzle(d1);
  const attempts = await db
    .select({ id: actionRunAttempts.id, runId: actionRunAttempts.runId })
    .from(actionRunAttempts)
    .where(and(eq(actionRunAttempts.repoId, repoId), eq(actionRunAttempts.concurrencyGroup, group), eq(actionRunAttempts.status, ACTION_STATUS_BLOCKED)));
  const jobs = await db
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.repoId, repoId), eq(actionRunJobs.concurrencyGroup, group), eq(actionRunJobs.status, ACTION_STATUS_BLOCKED)));
  return { attempts, jobs };
}

/** shouldBlockRunByConcurrency (clear_tasks.go:121-134): another run's
 *  entries in the group hold it → the attempt inserts BLOCKED. */
export async function shouldBlockRunByConcurrency(d1: D1Database, scope: ConcurrencyAttemptScope): Promise<boolean> {
  if (scope.concurrencyGroup === "") return false;
  const { attempts, jobs } = await getConcurrencyHolders(d1, scope.repoId, scope.concurrencyGroup);
  return (
    attempts.some((a) => a.runId !== scope.runId) ||
    jobs.some((j) => j.runId !== scope.runId)
  );
}

/** cancelOneJob (models/actions/run_job.go:804-832, force=false): a claimed
 *  job goes through StopTask's graceful CANCELLING handshake (update.ts's
 *  port); an unclaimed job CASes straight to cancelled (the task_id=0
 *  guard). Returns the cancelled row, or null when there was nothing to
 *  cancel (done, or a concurrent writer won). The CAS arm piggybacks the
 *  aggregate settle exactly as upstream's UpdateRunJob does
 *  (run_job.go:542 — every job-row status write refreshes the run). */
async function cancelOneJob(d1: D1Database, job: RunJobRow): Promise<RunJobRow | null> {
  if (isDoneStatus(job.status)) return null;
  if (job.taskId === 0) {
    const result = await drizzle(d1)
      .update(actionRunJobs)
      .set({ status: ACTION_STATUS_CANCELLED, stopped: new Date(), updated: new Date() })
      .where(and(eq(actionRunJobs.id, job.id), eq(actionRunJobs.taskId, 0)))
      .returning();
    if (result.length === 0) {
      console.error(`[actions-trigger] failed to cancel job ${job.id} because it has changed`);
      return null;
    }
    const cancelled = result[0];
    if (cancelled !== undefined) {
      await refreshRunStatus(d1, job.repoId, job.runId, job.runAttemptId);
    }
    return cancelled ?? null;
  }
  await stopTask(d1, job.taskId, ACTION_STATUS_CANCELLING); // StopTask refreshes the run itself
  const fresh = await drizzle(d1).select().from(actionRunJobs).where(eq(actionRunJobs.id, job.id)).limit(1);
  return fresh[0] ?? null;
}

/** createCommitStatusesForJobsByRun (job_emitter.go:135-151): the affected
 *  runs' statuses re-post after a cancel (the emit pass upstream runs
 *  through notifyAndEmitFinishedJobs posts every job's current state). */
async function createCommitStatusesForJobsByRun(d1: D1Database, runIds: number[]): Promise<void> {
  const db = drizzle(d1);
  for (const runId of runIds) {
    const runRows = await db.select().from(actionRuns).where(eq(actionRuns.id, runId)).limit(1);
    const run = runRows[0];
    if (run === undefined) continue;
    const repoRows = await db
      .select({ ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
      .from(repositories)
      .where(eq(repositories.id, run.repoId))
      .limit(1);
    const jobRows = await db.select().from(actionRunJobs).where(eq(actionRunJobs.runAttemptId, run.latestAttemptId));
    await createCommitStatusForRunJobs(
      d1,
      {
        run,
        repoOwnerNamespace: repoRows[0]?.ownerNamespace ?? "",
        repoSlug: repoRows[0]?.slug ?? "",
        eventPayloadJson: run.eventPayload,
        appUrl: "",
      },
      jobRows,
    );
  }
}

/**
 * findConcurrencyWaiterToWake (job_emitter.go:154-176, the attempt arm): a
 * blocked OTHER run on the group whose gate is now free. The job-waiter arm
 * is v1-dead (job groups store unevaluated — the module header), and the
 * expanded-caller exemption is v1-dead with it.
 */
async function findConcurrencyWaiterToWake(d1: D1Database, repoId: string, excludeRunId: number, group: string): Promise<number | null> {
  const { attempts } = await getConcurrencyWaiters(d1, repoId, group);
  for (const candidate of attempts) {
    if (candidate.runId === excludeRunId) continue;
    if (!(await shouldBlockRunByConcurrency(d1, { repoId, runId: candidate.runId, runAttemptId: candidate.id, concurrencyGroup: group, concurrencyCancel: false }))) {
      return candidate.runId;
    }
  }
  return null;
}

/**
 * CancelPreviousJobsByRunConcurrency (models/actions/run.go:407-426) — the
 * run-creation cancel arm: cancel-in-progress clears the group's UNFINISHED
 * entries, plain concurrency clears its BLOCKED waiters (getConcurrencyEntriesToReplace,
 * run.go:399-405); the new run's own entries are excluded, and the other
 * runs' cancelled attempts' jobs go too (getRunJobsByAttempts). Returns the
 * cancelled rows plus the distinct affected run ids for the emitter settle
 * (notifyAndEmitFinishedJobs, run.go:155-160, through our inline pass).
 */
export async function cancelPreviousJobsByRunConcurrency(
  d1: D1Database,
  scope: ConcurrencyAttemptScope,
): Promise<{ cancelled: RunJobRow[]; affectedRunIds: number[] }> {
  if (scope.concurrencyGroup === "") return { cancelled: [], affectedRunIds: [] };
  const entries = scope.concurrencyCancel
    ? await (async () => {
        const db = drizzle(d1);
        const unfinished = [ACTION_STATUS_BLOCKED, ACTION_STATUS_WAITING, ACTION_STATUS_RUNNING, ACTION_STATUS_CANCELLING];
        const attempts = await db
          .select({ id: actionRunAttempts.id, runId: actionRunAttempts.runId })
          .from(actionRunAttempts)
          .where(and(eq(actionRunAttempts.repoId, scope.repoId), eq(actionRunAttempts.concurrencyGroup, scope.concurrencyGroup), inArray(actionRunAttempts.status, unfinished)));
        const jobs = await db
          .select()
          .from(actionRunJobs)
          .where(and(eq(actionRunJobs.repoId, scope.repoId), eq(actionRunJobs.concurrencyGroup, scope.concurrencyGroup), inArray(actionRunJobs.status, unfinished)));
        return { attempts, jobs };
      })()
    : await getConcurrencyWaiters(d1, scope.repoId, scope.concurrencyGroup);

  const otherJobs = entries.jobs.filter((j) => j.runId !== scope.runId);
  const otherAttempts = entries.attempts.filter((a) => a.runId !== scope.runId);
  const attemptJobs =
    otherAttempts.length > 0
      ? await drizzle(d1)
          .select()
          .from(actionRunJobs)
          .where(inArray(actionRunJobs.runAttemptId, otherAttempts.map((a) => a.id)))
      : [];

  const cancelled: RunJobRow[] = [];
  for (const job of [...otherJobs, ...attemptJobs]) {
    const row = await cancelOneJob(d1, job);
    if (row !== null) cancelled.push(row);
  }
  const affectedRunIds = [...new Set(cancelled.map((j) => j.runId))].filter((id) => id !== scope.runId);
  return { cancelled, affectedRunIds };
}

// ---------------------------------------------------------------------------
// The job `if:` gate (§D2 #8 — decideJobIf/resolveJobIf/evaluateJobIf
// services/actions/helper.go:123-150 + EvaluateJobIfExpression
// jobparser/model.go:489-498)
// ---------------------------------------------------------------------------

/**
 * upsertJobErrorSummary (helper.go:152-156): the summary row keyed by
 * (repo, run, attempt, job, step 0) — UpsertActionRunJobSummary's
 * UNIQUE(summary_key) insert-or-update.
 */
async function upsertJobErrorSummary(
  d1: D1Database,
  job: Pick<RunJobRow, "repoId" | "runId" | "runAttemptId" | "id" | "jobId">,
  key: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const content = `Error when evaluating \`${key}\` for job \`${job.jobId}\`.\n\n\`\`\`\n${message}\n\`\`\`\n`;
  const now = new Date();
  const contentSize = new TextEncoder().encode(content).length;
  await drizzle(d1)
    .insert(actionRunJobSummaries)
    .values({
      repoId: job.repoId,
      runId: job.runId,
      runAttemptId: job.runAttemptId,
      jobId: job.id,
      stepIndex: 0,
      content,
      contentType: "text/markdown",
      contentSize,
      created: now,
      updated: now,
    })
    .onConflictDoUpdate({
      target: [actionRunJobSummaries.repoId, actionRunJobSummaries.runId, actionRunJobSummaries.runAttemptId, actionRunJobSummaries.jobId, actionRunJobSummaries.stepIndex],
      set: { content, contentType: "text/markdown", contentSize, updated: now },
    });
}

/**
 * The needs context for an if-evaluation (findJobNeedsAndFillJobResults,
 * helper.go:196-226 over FindTaskNeeds context.go:150-219): the direct
 * needs' aggregate results + their done tasks' outputs, the transitive
 * needs' aggregate-only entries, and the job's own {needs} entry. v1: one
 * row per jobId per attempt, so the same-jobId aggregate is that row.
 */
async function needsJobResults(
  d1: D1Database,
  job: Pick<RunJobRow, "jobId" | "needs" | "runId">,
  rowsById: Map<string, RunJobRow[]>,
): Promise<Record<string, ServerJobResult>> {
  const parseNeeds = (raw: string): string[] => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [];
    }
  };
  const results: Record<string, ServerJobResult> = {};
  const ownNeeds = parseNeeds(job.needs);
  results[job.jobId] = { needs: ownNeeds };
  if (ownNeeds.length === 0) return results;

  const outputsOf = async (rows: RunJobRow[]): Promise<Record<string, string> | undefined> => {
    let merged: Record<string, string> | undefined;
    for (const row of rows) {
      if (!isDoneStatus(row.status) || row.taskId === 0) continue;
      const outs = await drizzle(d1).select().from(actionTaskOutputs).where(eq(actionTaskOutputs.taskId, row.taskId));
      if (outs.length === 0) continue;
      merged = merged ?? {};
      for (const o of outs) merged[o.outputKey] = o.outputValue;
    }
    return merged;
  };

  const queue = [...ownNeeds];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const needId = queue.shift()!;
    if (seen.has(needId)) continue;
    seen.add(needId);
    const rows = rowsById.get(needId) ?? [];
    if (rows.length === 0) continue;
    if (results[needId] === undefined) {
      // AggregateJobStatus over the same-jobId rows (context.go:217-219) —
      // v1 rows are one per id, so the aggregate is the row's status
      results[needId] = { result: statusResultString(aggregateJobStatus(rows.map(toAggregateJob))) };
    }
    const needsOfNeed = parseNeeds(rows[0]?.needs ?? "[]");
    if (results[needId]?.needs === undefined) results[needId] = { ...results[needId], needs: needsOfNeed };
    queue.push(...needsOfNeed);
  }
  for (const needId of ownNeeds) {
    const rows = rowsById.get(needId) ?? [];
    const outputs = await outputsOf(rows);
    if (outputs !== undefined && results[needId] !== undefined) {
      results[needId] = { ...results[needId], outputs };
    }
  }
  return results;
}

export interface JobIfVerdict {
  shouldStart: boolean;
  /** The invalid-`if:` summary text (helper.go:152-156's render) — set when
   *  the evaluation failed the way upstream reports in the job's summary
   *  (evaluateJobIf's ErrInvalidArgument arm, :123-131). */
  invalidSummary: string | null;
  /** A DB-side failure (FindTaskNeeds/inputs arms) — upstream logs and
   *  leaves the job blocked (job_emitter.go:590-593); never a summary. */
  dbError: Error | null;
}

/**
 * EvaluateJobIfExpression's port (model.go:489-498): the defensive
 * unavailable-context re-check ("a stored job before its conditions were
 * validated" — our static scan covers detection-time rows, but a stored
 * payload predating the scan reads through here) + EvalBool under the
 * implicit success check, restricted contexts github/gitea/needs/vars/inputs
 * ONLY (validate.go:19-20 — the newServerInterpeter set without
 * strategy/matrix). gitCtx.job is "" (helper.go:171: "github.com decides a
 * job's `if:` before the job exists").
 */
export function evaluateJobIfExpression(input: {
  jobId: string;
  rawIf: string;
  githubContext: unknown;
  results: Record<string, ServerJobResult>;
  vars: Record<string, string> | undefined;
}): { value: boolean; invalidSummary: string | null } {
  const unavailable = unavailableContext(ifExpression(input.rawIf), jobConditionContexts);
  if (unavailable !== "") {
    return {
      value: false,
      invalidSummary: `job ${input.jobId}: Unrecognized named-value: '${unavailable}', update the workflow and trigger a new run`,
    };
  }
  const evaluator = serverEvaluator(input.githubContext, {
    jobId: input.jobId,
    results: input.results,
    vars: input.vars,
    inputs: undefined,
  });
  const verdict = evaluator.evalBool(input.rawIf, DefaultStatusCheck.Success);
  if (verdict.error !== null) {
    // resolveJobIf wraps ANY evaluation error as ErrInvalidArgument
    // (helper.go:174-175) — the invalid-summary arm, the D5 "late" posture
    return { value: false, invalidSummary: verdict.error.message };
  }
  return { value: verdict.value, invalidSummary: null };
}

/**
 * decideJobIf (helper.go:132-144) at insert: a WAITING job's `if:` decides
 * before insertion; empty → the implicit success() (allNeedsSucceed —
 * always true for the no-needs job an insert-time waiting job is); false or
 * invalid → SKIPPED (invalid adds the summary, written after the row
 * insert, insertRunJob run.go:282-286).
 */
function decideJobIfAtInsert(input: {
  jobId: string;
  rawIf: string;
  githubContext: unknown;
  vars: Record<string, string>;
}): { shouldStart: boolean; invalidSummary: string | null } {
  if (input.rawIf === "") {
    return { shouldStart: true, invalidSummary: null };
  }
  const verdict = evaluateJobIfExpression({
    jobId: input.jobId,
    rawIf: input.rawIf,
    githubContext: input.githubContext,
    results: { [input.jobId]: {} },
    vars: input.vars,
  });
  return { shouldStart: verdict.value, invalidSummary: verdict.invalidSummary };
}

/** WorkflowDisplayName (workflows.go:146-156): the workflow's `name:` if
 *  non-blank, else the base file name. */
export function workflowDisplayName(file: string, content: string): string {
  let displayName = file.split("/").pop() ?? file;
  try {
    const doc = parseDocument(content);
    const name = doc.get("name");
    if (typeof name === "string" && name.trim() !== "") {
      displayName = name.trim();
    }
  } catch {
    // unparsable → the base name stands
  }
  return displayName;
}

/** WorkflowStatusContextName (workflows.go:158-161). */
export function workflowStatusContextName(displayName: string, jobName: string, event: string): string {
  return `${displayName} / ${jobName} (${event})`.trim();
}

/** ShouldEventCreateCommitStatus (workflows.go:172-178). */
export function shouldEventCreateCommitStatus(event: string): boolean {
  return ["push", "pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment", "release"].includes(event);
}

// ---------------------------------------------------------------------------
// Commit statuses (services/actions/commit_status.go)
// ---------------------------------------------------------------------------

/** toCommitStatus (commit_status.go:357-370) → the landed table's states. */
export function toCommitStatus(status: number): "pending" | "success" | "failure" | "warning" | "skipped" | "error" {
  switch (status) {
    case ACTION_STATUS_SUCCESS:
      return "success";
    case ACTION_STATUS_FAILURE:
    case ACTION_STATUS_CANCELLED:
      return "failure";
    case ACTION_STATUS_WAITING:
    case ACTION_STATUS_BLOCKED:
    case ACTION_STATUS_PENDING:
      // RUNNING/CANCELLING ride too (upstream's pending family) — the v1 rows
      // this module writes never hold them at status-creation time.
      return "pending";
    case ACTION_STATUS_SKIPPED:
      return "skipped";
    default:
      return "error";
  }
}

/** toCommitStatusDescription (commit_status.go:372-394) — the duration-bearing
 *  arms render the seconds shape of job.DurationString (0s when unstarted). */
export function toCommitStatusDescription(job: { status: number; started: Date | null; stopped: Date | null }): string {
  const duration = () => {
    if (job.started === null || job.stopped === null) return "0s";
    return `${Math.max(0, Math.round((job.stopped.getTime() - job.started.getTime()) / 1000))}s`;
  };
  switch (job.status) {
    case ACTION_STATUS_SUCCESS:
      return `Successful in ${duration()}`;
    case ACTION_STATUS_FAILURE:
      return `Failing after ${duration()}`;
    case ACTION_STATUS_CANCELLED:
      return `Canceled after ${duration()}`;
    case ACTION_STATUS_SKIPPED:
      return "Skipped";
    case ACTION_STATUS_PENDING:
      return "Waiting for needed jobs";
    case ACTION_STATUS_WAITING:
      return "Waiting to run";
    case ACTION_STATUS_BLOCKED:
      return "Blocked by required conditions";
    default:
      return `Unknown status: ${job.status}`;
  }
}

/** The Actions system doer (user_model.ActionsUserID) — the status creator
 *  (commit_status.go:306-310, NewActionsUser). */
export const ACTIONS_USER_ID = -2;

/**
 * getCommitStatusEventNameAndCommitID (commit_status.go:74-141) for the wired
 * family: push reads payload.HeadCommit.ID; pull_request(_target) reads
 * PullRequest.Head.Sha. The release arm (commitID = run.CommitSHA) rides with
 * the release producer; create/delete/events produce no status (upstream's
 * default arm).
 */
/** A defensive payload read: unparseable JSON or a missing field answers "". */
function payloadField(eventPayloadJson: string, read: (payload: Record<string, unknown>) => string): string {
  try {
    return read(JSON.parse(eventPayloadJson) as Record<string, unknown>);
  } catch {
    return "";
  }
}

export function commitStatusEventAndCommit(run: Pick<RunRow, "event" | "triggerEvent" | "commitSha">, eventPayloadJson: string): { event: string; commitId: string } {
  switch (run.event) {
    case "push": {
      const headCommitId = payloadField(eventPayloadJson, (payload) => {
        const head = payload["head_commit"] as { id?: string } | null | undefined;
        return head?.id ?? "";
      });
      if (headCommitId === "") {
        // head commit is missing in event payload → no status
        return { event: "", commitId: "" };
      }
      return { event: "push", commitId: headCommitId };
    }
    case "pull_request":
    case "pull_request_sync":
    case "pull_request_assign":
    case "pull_request_label":
    case "pull_request_review_request":
    case "pull_request_milestone": {
      const event = run.triggerEvent === "pull_request_target" ? "pull_request_target" : "pull_request";
      const headSha = payloadField(eventPayloadJson, (payload) => {
        const pr = payload["pull_request"] as { head?: { sha?: string } } | null | undefined;
        return pr?.head?.sha ?? "";
      });
      if (headSha === "") {
        return { event: "", commitId: "" };
      }
      return { event, commitId: headSha };
    }
    default:
      return { event: "", commitId: "" };
  }
}

export interface StatusJobLike {
  id: number;
  jobId: string;
  name: string;
  status: number;
  started: Date | null;
  stopped: Date | null;
  /** The drizzle blob column reads back `unknown`; narrow through payloadText. */
  workflowPayload: unknown;
  isMatrixDeferred: boolean;
}

/** asBytes (dispatch.ts's narrowing rule) → payload text for context naming. */
function payloadText(value: unknown): string {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else {
    throw new Error("actions: blob column did not return bytes");
  }
  return new TextDecoder().decode(bytes);
}

/**
 * createCommitStatusForRunJobs (commit_status.go:31-63) minus the deferred
 * placeholders' skip (the status settles when the emitter re-creates; v1 rows
 * carry no isMatrixDeferred). The pendingFilter arm (newPendingJobFilter +
 * onlyReplace, :144-181): optional PENDING jobs whose context matches no
 * required glob post nothing.
 */
export async function createCommitStatusForRunJobs(
  d1: D1Database,
  opts: {
    run: Pick<RunRow, "id" | "repoId" | "workflowId" | "event" | "triggerEvent" | "commitSha" | "scheduleId">;
    repoOwnerNamespace: string;
    repoSlug: string;
    eventPayloadJson: string;
    appUrl: string;
  },
  jobs: StatusJobLike[],
): Promise<void> {
  // don't create commit status for cron job (commit_status.go:36-38)
  if (opts.run.scheduleId !== 0) return;
  const { event, commitId } = commitStatusEventAndCommit(opts.run, opts.eventPayloadJson);
  if (event === "" || commitId === "") return;

  const requiredGlobs = await requiredStatusContextGlobs(d1, opts.run.repoId);
  const hasPendingJob = jobs.some((job) => job.status === ACTION_STATUS_PENDING && !job.isMatrixDeferred);
  // newPendingJobFilter (commit_status.go:146-167): the filter compiles only
  // when some job is pending — nil upstream, no treatment here otherwise
  const pendingFilterArmed = hasPendingJob;

  for (const job of jobs) {
    if (job.isMatrixDeferred && !isDoneStatus(job.status)) continue;
    const displayName = workflowDisplayName(opts.run.workflowId, payloadText(job.workflowPayload));
    const ctxName = workflowStatusContextName(displayName, job.name, event);
    const description = toCommitStatusDescription(job);
    const targetUrl = `${opts.appUrl}/${opts.repoOwnerNamespace}/${opts.repoSlug}/actions/runs/${opts.run.id}/jobs/${job.id}`;
    const state = toCommitStatus(job.status);
    // onlyReplace (commit_status.go:174-177): a PENDING job whose context
    // matches no required glob posts nothing (optional pending jobs don't
    // spam statuses); the filter object is run-scoped (pendingFilterArmed)
    // and the pending check is per-job (upstream's `job.Status.IsPending()`
    // term under `f != nil`).
    const onlyReplace = pendingFilterArmed && job.status === ACTION_STATUS_PENDING && !matchesAnyGlob(requiredGlobs, ctxName);
    await createWorkflowCommitStatus(d1, {
      repoId: opts.run.repoId,
      commitId,
      ctxName,
      workflowId: opts.run.workflowId,
      state,
      targetUrl,
      description,
      onlyReplace,
    });
  }
}

/** IsDone (models/actions/status.go): the four terminal statuses. */
export function isDoneStatus(status: number): boolean {
  return status === ACTION_STATUS_SUCCESS || status === ACTION_STATUS_FAILURE || status === ACTION_STATUS_CANCELLED || status === ACTION_STATUS_SKIPPED;
}

function matchesAnyGlob(globs: Glob[], value: string): boolean {
  return globs.some((g) => g.match(value));
}

/**
 * requiredStatusContextGlobs (commit_status.go:197-215 over the landed
 * branch-protection store): the union of every rule's statusCheckContexts
 * (upstream EffectiveRequiredContexts' repo-wide union — its own TODO names
 * the over-approximation, commit_status.go:244-248); scoped-workflow patterns
 * stage with their feature. Contexts compile with plain glob.Compile.
 */
export async function requiredStatusContextGlobs(d1: D1Database, repoId: string): Promise<Glob[]> {
  let rules: ProtectedBranchRow[];
  try {
    rules = await listRepoRules(d1, repoId);
  } catch {
    return [];
  }
  const contexts: string[] = [];
  for (const rule of rules) {
    const config = parseRuleConfig(rule.rules);
    if (config.enableStatusCheck) {
      for (const ctx of config.statusCheckContexts) {
        if (!contexts.includes(ctx)) contexts.push(ctx);
      }
    }
  }
  return contexts.map((c) => compileActivityGlob(c));
}

/**
 * createWorkflowCommitStatus (commit_status.go:284-332) on the landed table:
 * the identical-state short-circuit, the onlyReplace-no-previous skip, and
 * the workflow-path-mixed dedupe key reduction (the table groups by `context`
 * alone — the module-header disclosure; upstream mixes the workflow path into
 * a context hash, commit_status.go:285-291, so two same-named workflows
 * sharing a job name supersede each other here where upstream keeps both).
 * The legacy-hash adoption arm (:292-302) is unreachable (no hash column).
 */
export async function createWorkflowCommitStatus(
  d1: D1Database,
  input: {
    repoId: string;
    commitId: string;
    ctxName: string;
    workflowId: string;
    state: "pending" | "success" | "failure" | "warning" | "skipped" | "error";
    targetUrl: string;
    description: string;
    onlyReplace: boolean;
  },
): Promise<void> {
  const db = drizzle(d1);
  const existing = await db
    .select()
    .from(commitStatuses)
    .where(and(eq(commitStatuses.repoId, input.repoId), eq(commitStatuses.sha, input.commitId), eq(commitStatuses.context, input.ctxName)))
    .orderBy(desc(commitStatuses.id))
    .limit(1);
  const previous = existing[0];
  if (previous !== undefined) {
    if (previous.state === input.state && previous.targetUrl === input.targetUrl && previous.description === input.description) {
      return;
    }
  } else if (input.onlyReplace) {
    return;
  }
  const now = new Date();
  await db.insert(commitStatuses).values({
    repoId: input.repoId,
    sha: input.commitId,
    state: input.state,
    targetUrl: input.targetUrl,
    description: input.description,
    context: input.ctxName,
    creatorId: ACTIONS_USER_ID,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * CreateSkippedCommitStatusForFilteredWorkflow (commit_status.go:250-282):
 * a branch/paths-filtered workflow whose context is a REQUIRED check posts a
 * skipped status (so required checks stay satisfiable); non-required
 * contexts post nothing. No run is created, so no target URL.
 */
export async function createSkippedCommitStatusForFilteredWorkflow(
  d1: D1Database,
  input: {
    repoId: string;
    event: string;
    triggerEvent: string;
    workflowId: string;
    content: string;
    payloadJson: string;
    requiredGlobs: Glob[];
  },
): Promise<void> {
  if (input.requiredGlobs.length === 0) return;
  let statusEvent = "";
  let commitId = "";
  if (input.event === "push") {
    try {
      const payload = JSON.parse(input.payloadJson) as { head_commit?: { id?: string } | null };
      if (payload.head_commit?.id) {
        statusEvent = "push";
        commitId = payload.head_commit.id;
      }
    } catch {
      // unsupported payload → nothing to post
    }
  } else if (["pull_request", "pull_request_sync", "pull_request_assign", "pull_request_label", "pull_request_review_request", "pull_request_milestone"].includes(input.event)) {
    try {
      const payload = JSON.parse(input.payloadJson) as { pull_request?: { head?: { sha?: string } } | null };
      if (payload.pull_request?.head?.sha) {
        statusEvent = input.triggerEvent === "pull_request_target" ? "pull_request_target" : "pull_request";
        commitId = payload.pull_request.head.sha;
      }
    } catch {
      // unsupported payload → nothing to post
    }
  }
  if (statusEvent === "" || commitId === "") return;

  const displayName = workflowDisplayName(input.workflowId, input.content);
  let payloads: SingleJobPayload[];
  try {
    payloads = splitWorkflowPayloads(input.content);
  } catch {
    return;
  }
  for (const sw of payloads) {
    const ctxName = workflowStatusContextName(displayName, sw.name, statusEvent);
    if (!matchesAnyGlob(input.requiredGlobs, ctxName)) continue;
    await createWorkflowCommitStatus(d1, {
      repoId: input.repoId,
      commitId,
      ctxName,
      workflowId: input.workflowId,
      state: "skipped",
      targetUrl: "",
      description: "Skipped",
      onlyReplace: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Run numbering (the HANDOFF interim — see the module header)
// ---------------------------------------------------------------------------

/**
 * The per-repo run index — upstream's `action_run_index` named sequence via
 * GetNextResourceIndex (models/db/index.go:115-168, an UPSERT+read inside the
 * insert transaction) mapped to `repo_counters.run_index` (SPEC §4.5). One
 * D1 batch = one SQLite transaction, so concurrent callers get strictly
 * sequential values:
 *
 *   1. bootstrap — create the counter row AT the repo's current max
 *     (rows that predate the column carry 0; never rewind);
 *   2. repair — raise a stale row to the repo's max, guarded by max() so a
 *     counter that is ahead (the two max+1 writers bypass the bump) stands;
 *   3. allocate — `run_index = run_index + 1 RETURNING`, the issues/service
 *     §3.1 idiom.
 *
 * The `UNIQUE(repo_id, index)` backstop on action_runs stays for the two
 * max+1 writers outside this counter (invalid-workflow runs, repo-actions
 * routes) — see the repoCounters table comment.
 */
export async function nextRunIndex(d1: D1Database, repoId: string): Promise<number> {
  const db = drizzle(d1);
  const maxIndex = sql`(SELECT coalesce(max(${actionRuns.index}), 0) FROM ${actionRuns} WHERE ${actionRuns.repoId} = ${repoId})`;
  const results = await db.batch([
    // bootstrap at the repo's max (a missing row starts at the max, not 0)
    db
      .insert(repoCounters)
      .values({ repoId, runIndex: maxIndex })
      .onConflictDoNothing(),
    // repair: never rewind, never lower a counter that is ahead of the rows
    db
      .update(repoCounters)
      .set({ runIndex: sql`max(run_index, ${maxIndex})` })
      .where(eq(repoCounters.repoId, repoId)),
    // allocate
    db
      .update(repoCounters)
      .set({ runIndex: sql`run_index + 1` })
      .where(eq(repoCounters.repoId, repoId))
      .returning({ allocated: repoCounters.runIndex }),
  ]);
  const allocated = results[2][0]?.allocated;
  if (allocated === undefined) {
    throw new Error("actions: run-index counter allocation returned no row");
  }
  return allocated;
}

// ---------------------------------------------------------------------------
// InsertRun mechanics (services/actions/run.go:63-217, the P slice)
// ---------------------------------------------------------------------------

export interface TriggeredRunInput {
  repoId: string;
  ownerId: number;
  workflowId: string;
  triggerUserId: number;
  ref: string;
  commitSha: string;
  isForkPullRequest: boolean;
  event: string;
  eventPayloadJson: string;
  triggerEvent: string;
  /** The commit subject (upstream commit.MessageTitle() → the run title). */
  title: string;
  repoOwnerNamespace: string;
  repoSlug: string;
  appUrl: string;
}

export interface TriggerRunOutcome {
  run: RunRow;
  jobs: RunJobRow[];
}

/**
 * PrepareRunAndInsert+InsertRun (run.go:24-217): the payload split (Parse's
 * slice), run index via the counter CAS, run row (waiting), attempt-1 row,
 * the E2 run-name interpolation (:120-134), the E4 workflow-level
 * concurrency fill + gate (:83-115), per-job statuses (waiting; PENDING when
 * it has needs :214-216; decideJobIf :246), the invalid-`if:` summaries
 * (:282-286), the task-version bump (:159-165), commit statuses (:45-52),
 * and the post-commit emitter kick (:172-178 + notifyAndEmitFinishedJobs
 * :155-160, inline per the module-header adaptation).
 *
 * Upstream does all of this inside ONE transaction: any failure after the
 * run insert (a run-name interpolation error, a concurrency evaluation
 * error) aborts it and NO run lands. There is no cross-statement
 * transaction on D1, so those failures compensate: the inserted
 * run/attempt rows are deleted and the counter's consumed value is rolled
 * back GUARDED (only when it still equals the consumed index — a concurrent
 * allocation stands, leaving a skipped number, which counters tolerate).
 * The error then propagates — handleWorkflows logs-and-continues
 * (notifier_helper.go:357-361).
 */
export async function insertTriggeredRun(
  d1: D1Database,
  input: TriggeredRunInput,
  workflowContent: string,
): Promise<TriggerRunOutcome> {
  const split = splitWorkflowPayloads(workflowContent);
  const rawConcurrency = readWorkflowRawConcurrency(workflowContent);
  return insertTriggeredRunSplit(d1, input, split, rawConcurrency);
}

/**
 * The insert half split from the payload split so the emitter's re-entry and
 * tests can drive a pre-computed split (upstream Parse then InsertRun).
 * `wfRawConcurrency` is PrepareRunAndInsert's ReadWorkflowRawConcurrency
 * product (run.go:39-41).
 */
export async function insertTriggeredRunSplit(
  d1: D1Database,
  input: TriggeredRunInput,
  split: SingleJobPayload[],
  wfRawConcurrency: RawConcurrency | null = null,
): Promise<TriggerRunOutcome> {
  const db = drizzle(d1);
  const now = new Date();

  // PrepareRunAndInsert's shared pre-insert reads (run.go:34-37): vars;
  // inputs stay nil on the push family (workflow_dispatch resolves its own).
  const vars = await loadActionsVariables(d1, input.ownerId, input.repoId);

  /**
   * The transaction-abort reproduction: drop the rows the failed insert
   * wrote and give the consumed index back (guarded — see the docstring).
   */
  const compensate = async (runId: number, consumedIndex: number): Promise<void> => {
    await db.delete(actionRunJobs).where(eq(actionRunJobs.runId, runId));
    await db.delete(actionRunAttempts).where(eq(actionRunAttempts.runId, runId));
    await db.delete(actionRuns).where(eq(actionRuns.id, runId));
    await db
      .update(repoCounters)
      .set({ runIndex: sql`run_index - 1` })
      .where(and(eq(repoCounters.repoId, input.repoId), eq(repoCounters.runIndex, consumedIndex)));
  };

  // Attempt 1..N retries on the UNIQUE(index) race the max+1 writers
  // (invalid-workflow, repo-actions) can still produce against the counter;
  // two collisions in one beat is the pathological case.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const index = await nextRunIndex(d1, input.repoId);
      const runRows = await db
        .insert(actionRuns)
        .values({
          title: ellipsisDisplayString(input.title, 255),
          repoId: input.repoId,
          ownerId: input.ownerId,
          workflowId: input.workflowId,
          index,
          triggerUserId: input.triggerUserId,
          ref: input.ref,
          commitSha: input.commitSha,
          isForkPullRequest: input.isForkPullRequest,
          event: input.event,
          eventPayload: input.eventPayloadJson,
          triggerEvent: input.triggerEvent,
          status: ACTION_STATUS_WAITING,
          created: now,
          updated: now,
        })
        .returning();
      const run = runRows[0];
      if (run === undefined) {
        throw new Error("actions: run insert returned no row");
      }
      const attemptRows = await db
        .insert(actionRunAttempts)
        .values({
          repoId: input.repoId,
          runId: run.id,
          attempt: 1,
          triggerUserId: input.triggerUserId,
          status: ACTION_STATUS_WAITING,
          created: now,
          updated: now,
        })
        .returning();
      const runAttempt = attemptRows[0];
      if (runAttempt === undefined) {
        throw new Error("actions: attempt insert returned no row");
      }
      await db.update(actionRuns).set({ latestAttemptId: runAttempt.id, updated: now }).where(eq(actionRuns.id, run.id));
      // the returned row mirrors the persisted linkage (upstream keeps
      // run.LatestAttemptID populated in memory through the transaction)
      run.latestAttemptId = runAttempt.id;
      run.rawConcurrency = wfRawConcurrency !== null ? marshalRawConcurrency(wfRawConcurrency) : "";

      // Insert BEFORE the expression work so github.run_id / run_number
      // interpolate for real (run.go:80-89's own ordering comment); the
      // transaction-abort posture is the compensating pair above.
      const abort = async (err: unknown, failure: string): Promise<never> => {
        await compensate(run.id, index);
        throw new Error(`${failure}: ${err instanceof Error ? err.message : String(err)}`);
      };

      const githubContext = await buildGithubContext(d1, {
        repoId: input.repoId,
        ownerId: input.ownerId,
        repoOwnerNamespace: input.repoOwnerNamespace,
        repoSlug: input.repoSlug,
        runId: run.id,
        runNumber: index,
        runAttempt: "1",
        triggerUserId: input.triggerUserId,
        ref: input.ref,
        commitSha: input.commitSha,
        workflowId: input.workflowId,
        workflowSha: input.commitSha, // WorkflowCommitSHA = the content commit (dwf.SourceCommitSHA)
        eventName: input.triggerEvent,
        eventPayloadJson: input.eventPayloadJson,
        appUrl: input.appUrl,
      });

      // E2 — the run-name render (jobparser.go:103-106 interpolates
      // workflow.RunName with github/vars/inputs only; run.go:121-127 lifts
      // jobs[0].RunName over the commit-subject title when non-empty).
      const first = split[0];
      if (first !== undefined && first.runName !== "") {
        let runName = "";
        try {
          const evaluator = serverEvaluator(githubContext, { jobId: "", results: {}, vars, inputs: undefined });
          const interpolated = evaluator.interpolate(first.runName);
          if (interpolated.error !== null) throw interpolated.error;
          runName = interpolated.value;
        } catch (err) {
          await abort(err, "interpolate run-name");
        }
        if (runName !== "") {
          const title = ellipsisDisplayString(runName, 255);
          await db.update(actionRuns).set({ title, updated: now }).where(eq(actionRuns.id, run.id));
          run.title = title;
        }
      }

      // E4 — the workflow-level concurrency (run.go:83-115): the raw node
      // stores (run.RawConcurrency), the fill model evaluates group/cancel
      // into the attempt, and the gate cancels-or-blocks (needApproval is
      // v1-dead: no approval producer on the push family).
      let attemptStatus = ACTION_STATUS_WAITING;
      const affectedByCancel: number[] = [];
      if (wfRawConcurrency !== null) {
        let group = "";
        let cancel = false;
        try {
          ({ group, cancel } = evaluateRunConcurrency(githubContext, wfRawConcurrency, vars));
        } catch (err) {
          await abort(err, "evaluate concurrency");
        }
        await db
          .update(actionRunAttempts)
          .set({ concurrencyGroup: group, concurrencyCancel: cancel, updated: now })
          .where(eq(actionRunAttempts.id, runAttempt.id));
        runAttempt.concurrencyGroup = group;
        runAttempt.concurrencyCancel = cancel;
        await db.update(actionRuns).set({ rawConcurrency: run.rawConcurrency, updated: now }).where(eq(actionRuns.id, run.id));

        const scope: ConcurrencyAttemptScope = {
          repoId: input.repoId,
          runId: run.id,
          runAttemptId: runAttempt.id,
          concurrencyGroup: group,
          concurrencyCancel: cancel,
        };
        const { affectedRunIds } = await cancelPreviousJobsByRunConcurrency(d1, scope);
        affectedByCancel.push(...affectedRunIds);
        if (await shouldBlockRunByConcurrency(d1, scope)) {
          attemptStatus = ACTION_STATUS_BLOCKED;
          await db.update(actionRunAttempts).set({ status: attemptStatus, updated: now }).where(eq(actionRunAttempts.id, runAttempt.id));
        }
      }

      // insertRunJob's status arm (run.go:214-216 + the blocked-attempt
      // carry, :233-235): blocked attempt → blocked; else waiting; PENDING
      // while it has needs. decideJobIf (:246) then decides each WAITING
      // job's `if:` before insertion. attempt_job_id allocates 1..N per
      // attempt (GetNextAttemptJobID).
      const jobValues = split.map((job, i) => {
        let status =
          attemptStatus === ACTION_STATUS_BLOCKED
            ? ACTION_STATUS_BLOCKED
            : job.needs.length > 0
              ? ACTION_STATUS_PENDING
              : ACTION_STATUS_WAITING;
        let invalidIf: string | null = null;
        if (status === ACTION_STATUS_WAITING) {
          const decision = decideJobIfAtInsert({
            jobId: job.jobId,
            rawIf: job.rawIf,
            githubContext,
            vars,
          });
          invalidIf = decision.invalidSummary;
          if (!decision.shouldStart) {
            status = ACTION_STATUS_SKIPPED; // decideJobIf helper.go:141-143
          }
        }
        return {
          values: {
            runId: run.id,
            repoId: input.repoId,
            ownerId: input.ownerId,
            commitSha: input.commitSha,
            isForkPullRequest: input.isForkPullRequest,
            name: ellipsisDisplayString(job.name, 255),
            attempt: 1,
            workflowPayload: job.payload,
            jobId: job.jobId,
            needs: JSON.stringify(job.needs),
            runsOn: JSON.stringify(job.runsOn),
            status,
            rawConcurrency: job.rawConcurrency,
            isConcurrencyEvaluated: false, // the job-level gate stages with the matrix model
            maxParallel: job.maxParallel,
            continueOnError: job.continueOnError,
            runAttemptId: runAttempt.id,
            attemptJobId: i + 1,
            created: now,
            updated: now,
          },
          invalidIf,
        };
      });
      const jobRows: RunJobRow[] = [];
      const invalidIfRows: Array<{ row: RunJobRow; summary: string | null }> = [];
      const CHUNK = 2; // the ~40-column bind cap (model.ts's idiom)
      for (let i = 0; i < jobValues.length; i += CHUNK) {
        const chunk = jobValues.slice(i, i + CHUNK);
        if (chunk.length === 0) continue;
        const rows = await db.insert(actionRunJobs).values(chunk.map((j) => j.values)).returning();
        jobRows.push(...rows);
      }
      for (let i = 0; i < jobRows.length; i += 1) {
        const entry = jobValues[i];
        const row = jobRows[i];
        if (entry === undefined || row === undefined) continue;
        invalidIfRows.push({ row, summary: entry.invalidIf });
      }
      // upsertJobErrorSummary AFTER the job insert (run.go:282-286)
      for (const { row, summary } of invalidIfRows) {
        if (summary !== null) {
          await upsertJobErrorSummary(d1, row, "if", new Error(summary));
        }
      }

      // AggregateJobStatus (run.go:233-234) — the attempt settles to its
      // jobs' aggregate.
      const aggregate = aggregateJobStatus(jobRows.map(toAggregateJob));
      if (aggregate !== attemptStatus) {
        await db.update(actionRunAttempts).set({ status: aggregate, updated: now }).where(eq(actionRunAttempts.id, runAttempt.id));
        await db.update(actionRuns).set({ status: aggregate, updated: now }).where(eq(actionRuns.id, run.id));
        attemptStatus = aggregate;
      }
      run.status = attemptStatus;

      // if there is a job in the waiting status, increase tasks version
      // (run.go:157-165; a reusable caller never counts — no callers in v1;
      // a blocked or all-skipped run has none and stays asleep).
      const hasWaitingJobs = jobRows.some((j) => j.status === ACTION_STATUS_WAITING && !j.isReusableCaller);
      if (hasWaitingJobs) {
        await increaseTaskVersion(d1, input.ownerId, input.repoId);
      }

      // CreateCommitStatusForRunJobs (run.go:47-52)
      await createCommitStatusForRunJobs(
        d1,
        {
          run,
          repoOwnerNamespace: input.repoOwnerNamespace,
          repoSlug: input.repoSlug,
          eventPayloadJson: input.eventPayloadJson,
          appUrl: input.appUrl,
        },
        jobRows,
      );

      // The post-commit emitter kick (run.go:172-178's
      // needPostCommitEmit = a skipped/failed insert, plus
      // notifyAndEmitFinishedJobs :155-160's cancelled jobs): the pass
      // resolves the dependents of jobs this insert already terminalized;
      // the cancelled runs settle inside cancelOneJob (UpdateRunJob's
      // refresh piggyback) and get their statuses re-posted here
      // (createCommitStatusesForJobsByRun, job_emitter.go:135-151).
      const needPostCommitEmit = jobRows.some((j) => j.status === ACTION_STATUS_SKIPPED || j.status === ACTION_STATUS_FAILURE);
      if (needPostCommitEmit) {
        await checkJobsOfRun(d1, run.id);
      }
      if (affectedByCancel.length > 0) {
        for (const affectedRunId of affectedByCancel) {
          await checkJobsOfRun(d1, affectedRunId);
        }
        await createCommitStatusesForJobsByRun(d1, affectedByCancel);
      }
      // PrepareRunAndInsert's reload (run.go:60-64: "the job models in
      // InsertRun are partial, so load again") — the post-commit kick above
      // may have resolved dependents, so the outcome carries DB truth.
      const freshJobRows = await db
        .select()
        .from(actionRunJobs)
        .where(and(eq(actionRunJobs.runId, run.id), eq(actionRunJobs.runAttemptId, runAttempt.id)))
        .orderBy(actionRunJobs.id);
      return { run, jobs: freshJobRows.length > 0 ? freshJobRows : jobRows };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("UNIQUE constraint failed: action_runs.repo_id")) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("actions: run index race unresolved");
}

/** AggregateJobStatus (models/actions/run_job.go:509-554) — the P statuses. */
export function aggregateJobStatus(jobs: Array<{ status: number; continueOnError: boolean }>): number {
  const total = jobs.length;
  let allSuccessOrSkipped = total !== 0;
  let allSkipped = total !== 0;
  let hasFailure = false;
  let hasCancelled = false;
  let hasCancelling = false;
  let hasWaiting = false;
  let hasRunning = false;
  let hasBlocked = false;
  let hasPending = false;
  for (const job of jobs) {
    const isContinuedFailure = job.continueOnError && job.status === ACTION_STATUS_FAILURE;
    allSuccessOrSkipped =
      allSuccessOrSkipped && (job.status === ACTION_STATUS_SUCCESS || job.status === ACTION_STATUS_SKIPPED || isContinuedFailure);
    allSkipped = allSkipped && job.status === ACTION_STATUS_SKIPPED;
    hasFailure = hasFailure || (job.status === ACTION_STATUS_FAILURE && !job.continueOnError);
    hasCancelled = hasCancelled || job.status === ACTION_STATUS_CANCELLED;
    hasCancelling = hasCancelling || job.status === ACTION_STATUS_CANCELLING;
    hasWaiting = hasWaiting || job.status === ACTION_STATUS_WAITING;
    hasRunning = hasRunning || job.status === ACTION_STATUS_RUNNING;
    hasBlocked = hasBlocked || job.status === ACTION_STATUS_BLOCKED;
    hasPending = hasPending || job.status === ACTION_STATUS_PENDING;
  }
  if (allSkipped) return ACTION_STATUS_SKIPPED;
  if (allSuccessOrSkipped) return ACTION_STATUS_SUCCESS;
  if (hasCancelling) return ACTION_STATUS_CANCELLING;
  if (hasRunning) return ACTION_STATUS_RUNNING;
  if (hasWaiting) return ACTION_STATUS_WAITING;
  if (hasBlocked) return ACTION_STATUS_BLOCKED;
  if (hasPending) return ACTION_STATUS_RUNNING; // a run with only pending jobs left is still in progress
  if (hasCancelled) {
    // the fail-fast matrix arm (hasFailFastMatrixFailure) stages with the
    // matrix rows (the E tier); a v1 aggregate never carries it
    return ACTION_STATUS_CANCELLED;
  }
  if (hasFailure) return ACTION_STATUS_FAILURE;
  return 0; // ACTION_STATUS_UNKNOWN — "it shouldn't happen" (upstream's default)
}

function toAggregateJob(job: RunJobRow): { status: number; continueOnError: boolean } {
  return { status: job.status, continueOnError: job.continueOnError };
}

// ---------------------------------------------------------------------------
// The needs-graph emitter pass (services/actions/job_emitter.go, P slice)
// ---------------------------------------------------------------------------

/**
 * checkJobsOfRun (job_emitter.go:63-93 + checkJobsOfCurrentRunAttempt
 * :93-201 + jobStatusResolver.Resolve :507-527, the P slice): the
 * pending↔blocked needs flip, the implicit-success skip cascade (an empty
 * `if:` reduces to success() — true iff every need finished as Success,
 * helper.go:158-160 + resolveCheckNeeds job_emitter.go:…), max-parallel
 * slots, the attempt/run aggregate refresh (models/actions/run_job.go
 * refreshRunStatus :557-595), the task-version wake (UpdateRunJob
 * run_job.go:496-521), and the statuses refresh
 * (createCommitStatusesForJobsByRun :135-151).
 *
 * The E-tier arms (evaluateJobIf on a non-empty `if:` — helper.go:123-131,
 * concurrency, deferred matrices, reusable callers) stage: a non-empty bare
 * `if:` defaults to START (the module-header divergence).
 */
export async function checkJobsOfRun(d1: D1Database, runId: number): Promise<void> {
  const db = drizzle(d1);
  const runRows = await db.select().from(actionRuns).where(eq(actionRuns.id, runId)).limit(1);
  const run = runRows[0];
  if (run === undefined) {
    // a deleted run never comes back (job_emitter.go:66-69): drop silently
    return;
  }
  // Approval is the only transition allowed to release a run awaiting
  // approval (job_emitter.go:96-99).
  if (run.needApproval) return;

  const jobs = await db
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.runId, run.id), eq(actionRunJobs.runAttemptId, run.latestAttemptId)))
    .orderBy(actionRunJobs.id);
  if (jobs.length === 0) return;

  // The E3 gate's repo/attempt identity (the github context reads them):
  // loaded once here, reused by the statuses refresh below.
  const repoRecordRows = await db
    .select({ ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
    .from(repositories)
    .where(eq(repositories.id, run.repoId))
    .limit(1);
  const repoRecordNamespace = repoRecordRows[0]?.ownerNamespace ?? "";
  const repoRecordSlug = repoRecordRows[0]?.slug ?? "";
  const attemptNumberRows = await db
    .select({ attempt: actionRunAttempts.attempt, concurrencyGroup: actionRunAttempts.concurrencyGroup })
    .from(actionRunAttempts)
    .where(eq(actionRunAttempts.id, run.latestAttemptId))
    .limit(1);
  const attemptNumber = attemptNumberRows[0]?.attempt ?? 1;
  const attemptConcurrencyGroup = attemptNumberRows[0]?.concurrencyGroup ?? "";

  // The blocked-run re-check (checkJobsOfCurrentRunAttempt's head,
  // job_emitter.go:243-255): a run blocked solely by run-level concurrency
  // proceeds once the holding run finished; a still-held one drops the
  // pass — its jobs stay blocked and the wake arm (below) re-emits it.
  if (run.status === ACTION_STATUS_BLOCKED && attemptConcurrencyGroup !== "") {
    const stillHeld = await shouldBlockRunByConcurrency(d1, {
      repoId: run.repoId,
      runId: run.id,
      runAttemptId: run.latestAttemptId,
      concurrencyGroup: attemptConcurrencyGroup,
      concurrencyCancel: false,
    });
    if (stillHeld) return;
  }

  // needs graph scoped by job key (newJobStatusResolver :458-485): job key →
  // row ids, needs → sibling ids.
  const jobByKey = new Map<string, RunJobRow>();
  for (const job of jobs) jobByKey.set(job.jobId, job);
  const needsOf = new Map<number, number[]>();
  const parseNeeds = (raw: string): string[] => {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  };
  for (const job of jobs) {
    const ids = parseNeeds(job.needs)
      .map((n) => jobByKey.get(n))
      .filter((j): j is RunJobRow => j !== undefined)
      .map((j) => j.id);
    needsOf.set(job.id, ids);
  }

  // maxParallelSlots (max_parallel.go:22-71), scoped by (parentJobId, jobKey);
  // v1 rows never carry callers, so parentJobId is always 0.
  const slots = new Map<string, number>();
  const slotKey = (job: RunJobRow) => `${job.parentJobId}:${job.jobId}`;
  const slotHold = (job: RunJobRow, status: number): void => {
    if (job.maxParallel <= 0) return;
    if (status === ACTION_STATUS_RUNNING || status === ACTION_STATUS_WAITING || status === ACTION_STATUS_CANCELLING) {
      slots.set(slotKey(job), (slots.get(slotKey(job)) ?? 0) + 1);
    }
  };
  const slotAvailable = (job: RunJobRow): boolean => job.maxParallel <= 0 || (slots.get(slotKey(job)) ?? 0) < job.maxParallel;
  const slotTake = (job: RunJobRow): boolean => {
    if (!slotAvailable(job)) return false;
    if (job.maxParallel > 0) slots.set(slotKey(job), (slots.get(slotKey(job)) ?? 0) + 1);
    return true;
  };
  for (const job of jobs) slotHold(job, job.status);

  const statuses = new Map<number, number>(jobs.map((j) => [j.id, j.status]));
  const sortedIds = jobs.map((j) => j.id).sort((a, b) => a - b);
  const resolveCheckNeeds = (id: number): { allDone: boolean; allSucceed: boolean } => {
    let allDone = true;
    let allSucceed = true;
    for (const needId of needsOf.get(id) ?? []) {
      const needStatus = statuses.get(needId) ?? 0;
      if (!isDoneStatus(needStatus)) allDone = false;
      const needJob = jobs.find((j) => j.id === needId);
      // a failed need with continue-on-error is treated as success
      // (resolveCheckNeeds, job_emitter.go:529-547)
      if (needJob !== undefined && needJob.continueOnError && needStatus === ACTION_STATUS_FAILURE) continue;
      if (needStatus === ACTION_STATUS_FAILURE || needStatus === ACTION_STATUS_CANCELLED || needStatus === ACTION_STATUS_SKIPPED) {
        allSucceed = false;
      }
    }
    return { allDone, allSucceed };
  };

  // The E3 gate's shared per-pass context (evaluateJobIf, job_emitter.go:589
  // → resolveJobIf helper.go:152-176): vars and the github context load
   // lazily — only a pass that actually reaches a non-empty `if:` pays for
  // the reads. gitCtx.job is "" (helper.go:171).
  let passVars: Record<string, string> | null = null;
  let passGithubContext: Promise<Record<string, unknown>> | null = null;
  const githubContextOnce = (): Promise<Record<string, unknown>> => {
    if (passGithubContext === null) {
      passGithubContext = buildGithubContext(d1, {
        repoId: run.repoId,
        ownerId: run.ownerId,
        repoOwnerNamespace: repoRecordNamespace,
        repoSlug: repoRecordSlug,
        runId: run.id,
        runNumber: run.index,
        runAttempt: String(attemptNumber),
        triggerUserId: run.triggerUserId,
        ref: run.ref,
        commitSha: run.commitSha,
        workflowId: run.workflowId,
        workflowSha: run.commitSha,
        eventName: run.triggerEvent,
        eventPayloadJson: run.eventPayload,
        appUrl: "",
      });
    }
    return passGithubContext;
  };
  const rowsById = new Map<string, RunJobRow[]>();
  for (const job of jobs) {
    const list = rowsById.get(job.jobId);
    if (list === undefined) rowsById.set(job.jobId, [job]);
    else list.push(job);
  }

  const updatedJobIds: number[] = [];
  const now = new Date();
  // Resolve to a fixpoint (jobStatusResolver.Resolve's loop, :507-527).
  for (let round = 0; round <= jobs.length; round += 1) {
    const updates = new Map<number, number>();
    for (const id of sortedIds) {
      const status = statuses.get(id) ?? 0;
      const job = jobs.find((j) => j.id === id);
      if (job === undefined) continue;
      if (status !== ACTION_STATUS_PENDING && status !== ACTION_STATUS_BLOCKED) continue;
      if (job.isReusableCaller && job.isExpanded) continue;
      const { allDone, allSucceed } = resolveCheckNeeds(id);
      if (status === ACTION_STATUS_PENDING && allDone) {
        statuses.set(id, ACTION_STATUS_BLOCKED);
        job.status = ACTION_STATUS_BLOCKED;
        updates.set(id, ACTION_STATUS_BLOCKED);
      } else if (status === ACTION_STATUS_BLOCKED && !allDone) {
        statuses.set(id, ACTION_STATUS_PENDING);
        job.status = ACTION_STATUS_PENDING;
        updates.set(id, ACTION_STATUS_PENDING);
      }
      if (!allDone) continue;

      // The `if:` gate (evaluateJobIf, job_emitter.go:589-596): empty →
      // implicit success() — true iff every need finished as Success
      // (helper.go:158-160); non-empty → the E3 evaluation. An invalid
      // `if:` writes the job's summary and SKIPS; a DB-side failure logs
      // and leaves the job blocked.
      const rawIf = jobRawIf(job);
      let shouldStartJob: boolean;
      let invalidSummary: string | null = null;
      if (rawIf === "") {
        shouldStartJob = allSucceed;
      } else {
        if (passVars === null) passVars = await loadActionsVariables(d1, run.ownerId, run.repoId);
        const verdict = evaluateJobIfExpression({
          jobId: job.jobId,
          rawIf,
          githubContext: await githubContextOnce(),
          results: await needsJobResults(d1, job, rowsById),
          vars: passVars,
        });
        invalidSummary = verdict.invalidSummary;
        shouldStartJob = verdict.value;
      }
      if (invalidSummary !== null) {
        await upsertJobErrorSummary(d1, job, "if", new Error(invalidSummary));
      }
      if (!shouldStartJob) {
        statuses.set(id, ACTION_STATUS_SKIPPED);
        job.status = ACTION_STATUS_SKIPPED;
        updates.set(id, ACTION_STATUS_SKIPPED);
        continue;
      }

      if (!slotAvailable(job)) continue; // a slot-starved job stays blocked
      const newStatus = ACTION_STATUS_WAITING;
      if (!slotTake(job)) continue;
      statuses.set(id, newStatus);
      job.status = newStatus;
      updates.set(id, newStatus);
    }
    if (updates.size === 0) break;
    // persist the pass's updates (checkJobsOfCurrentRunAttempt's UpdateRunJob
    // CAS on the pre-resolve status — job_emitter.go:168-186; the two CAS
    // arms (pending→blocked, blocked→start/skip) collapse to one
    // status-in(pending,blocked) guard)
    for (const [id, status] of updates) {
      const job = jobs.find((j) => j.id === id);
      if (job === undefined) continue;
      const result = await db
        .update(actionRunJobs)
        .set({ status, updated: now })
        .where(and(eq(actionRunJobs.id, id), inArray(actionRunJobs.status, [ACTION_STATUS_PENDING, ACTION_STATUS_BLOCKED])))
        .returning({ id: actionRunJobs.id });
      if (result.length === 1) {
        updatedJobIds.push(id);
      } else {
        // a concurrent writer advanced the job; keep the DB truth
        // a concurrent writer advanced the job; keep the DB truth
        const fresh = await db.select().from(actionRunJobs).where(eq(actionRunJobs.id, id)).limit(1);
        if (fresh[0] !== undefined) {
          statuses.set(id, fresh[0].status);
          job.status = fresh[0].status;
        }
      }
    }
  }

  if (updatedJobIds.length === 0) return;

  // The task-version wake (UpdateRunJob run_job.go:496-521): a job returning
  // to waiting, or a terminal job with waiting work remaining.
  const updatedJobs = jobs.filter((j) => updatedJobIds.includes(j.id));
  const wakeWaiting = updatedJobs.some((j) => j.status === ACTION_STATUS_WAITING);
  let wakeDone = false;
  if (updatedJobs.some((j) => isDoneStatus(j.status))) {
    const waiting = await db
      .select({ id: actionRunJobs.id })
      .from(actionRunJobs)
      .where(and(eq(actionRunJobs.repoId, run.repoId), eq(actionRunJobs.taskId, 0), eq(actionRunJobs.status, ACTION_STATUS_WAITING)))
      .limit(1);
    wakeDone = waiting.length > 0;
  }
  if (wakeWaiting || wakeDone) {
    await increaseTaskVersion(d1, run.ownerId, run.repoId);
  }

  // refreshRunStatus (run_job.go:557-582): the attempt aggregates from its
  // jobs and persists its STATUS ONLY (the attempt arm never touches
  // started/stopped — that lives on the legacy run-row path :584-601, whose
  // started/stopped legs port below); the latest attempt propagates to its
  // run.
  const attemptRows = await db.select().from(actionRunAttempts).where(eq(actionRunAttempts.id, run.latestAttemptId)).limit(1);
  const attempt = attemptRows[0];
  const freshJobs = await db
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.runId, run.id), eq(actionRunJobs.runAttemptId, run.latestAttemptId)));
  const aggregate = aggregateJobStatus(freshJobs.map(toAggregateJob));
  if (attempt !== undefined && attempt.status !== aggregate) {
    await db.update(actionRunAttempts).set({ status: aggregate, updated: now }).where(eq(actionRunAttempts.id, attempt.id));
  }
  const runPatch: { status: number; updated: Date; started?: Date; stopped?: Date } | null =
    run.status !== aggregate
      ? {
          status: aggregate,
          updated: now,
          ...(run.started === null && aggregate === ACTION_STATUS_RUNNING ? { started: now } : {}),
          ...(run.stopped === null && isDoneStatus(aggregate) ? { stopped: now } : {}),
        }
      : null;
  if (runPatch !== null) {
    await db.update(actionRuns).set(runPatch).where(eq(actionRuns.id, run.id));
  }

  // checkRunConcurrency (job_emitter.go:181-234): this pass's run may hold
  // a group a blocked waiter can now enter — wake it (its own pass runs the
  // unblock re-check above). The group set is the run-level group (the
  // attempt's evaluated group) plus the done jobs' evaluated groups; v1 job
  // rows store unevaluated (the module header), so the job arm is dead.
  if (updatedJobIds.length > 0) {
    const passGroups = new Set<string>();
    if (attemptConcurrencyGroup !== "") passGroups.add(attemptConcurrencyGroup);
    for (const j of freshJobs) {
      if (isDoneStatus(j.status) && j.concurrencyGroup !== "" && j.isConcurrencyEvaluated) passGroups.add(j.concurrencyGroup);
    }
    for (const group of passGroups) {
      const woken = await findConcurrencyWaiterToWake(d1, run.repoId, run.id, group);
      if (woken !== null) {
        await checkJobsOfRun(d1, woken);
      }
    }
  }

  // createCommitStatusesForJobsByRun (job_emitter.go:135-151): the resolved
  // jobs' statuses re-post. The repo identity was loaded for the E3 gate.
  await createCommitStatusForRunJobs(
    d1,
    {
      run,
      repoOwnerNamespace: repoRecordNamespace,
      repoSlug: repoRecordSlug,
      eventPayloadJson: run.eventPayload,
      appUrl: "",
    },
    freshJobs,
  );
}

/** The stored payload's literal `if:` text (empty when absent) — the job's
 *  stored condition read back the way upstream's job.ParseJob reads it. */
function jobRawIf(job: RunJobRow): string {
  try {
    const doc = parseDocument(payloadText(job.workflowPayload));
    const jobsNode = doc.get("jobs", true) as YamlNode | undefined;
    if (jobsNode === undefined || !isMap(jobsNode) || jobsNode.items.length === 0) return "";
    const first = jobsNode.items[0];
    if (first === undefined) return "";
    const value = first.value as YamlNode;
    if (!isMap(value)) return "";
    const v = scalarValue(mapGet(value, "if"));
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "true" : "false";
    return "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// The claim-payload rewrite (services/actions/task.go:176-186)
// ---------------------------------------------------------------------------

/**
 * runnerWorkflowPayload (task.go:176-186): re-serialize the stored single-job
 * payload with the job's `if:` forced to the literal `always()` — "as Gitea
 * has decided it and a runner must not re-evaluate it". A payload that no
 * longer parses throws (the claim releases — dispatch's existing assembly
 * failure path). The M1a staged shape (dispatch.ts's module header) served
 * the bytes verbatim; this function replaces that stage.
 */
export function runnerWorkflowPayload(workflowPayload: Uint8Array): Uint8Array {
  const content = new TextDecoder().decode(workflowPayload);
  const doc = parseDocument(content);
  const jobs = doc.get("jobs", true) as YamlNode | undefined;
  if (jobs === undefined || !isMap(jobs) || jobs.items.length === 0) {
    throw new Error("payload contains no job");
  }
  const pair = jobs.items[0];
  if (pair === undefined) throw new Error("payload contains no job");
  const jobNode = pair.value as YamlNode;
  if (!isMap(jobNode)) throw new Error("payload contains no job");
  const jobId = keyText(pair.key as YamlNode | undefined);
  jobNode.set("if", "always()");
  return marshalSingleJob(doc, jobId, jobNode);
}

// ---------------------------------------------------------------------------
// The onPush consumer (services/actions/notifier.go:541-644 + notify
// :136-296 over our applied-updates delta)
// ---------------------------------------------------------------------------

/** The engine PushEvent (webhooks-push.ts's PushEventLike shape). */
export interface ActionsPushEvent {
  repo: string;
  updates: ReadonlyArray<{ ref: string; old: string; new: string }>;
  pusherId?: number;
  origin?: string;
}

const PUSH_ZERO_OID = "0".repeat(40);

export interface TriggerCellReads extends WorkflowTreeReads {
  readCommit(id: string): Promise<{ oid: string; tree: string; parents: string[]; subject: string; message: string; author: { name: string; email: string }; committer: { name: string; email: string } } | null>;
  listCommitsRange(base: string, head: string, limit: number): Promise<{ commits: Array<{ oid: string; parents: string[]; subject: string; message: string; author: { name: string; email: string }; committer: { name: string; email: string } }> } | null>;
  listLog(ref: string, opts: { ofs: number; n: number }): Promise<{ commits: Array<{ oid: string; parents: string[]; subject: string; message: string; author: { name: string; email: string }; committer: { name: string; email: string } }> } | null>;
  readDiff(id: string, id2: string): Promise<{ files: Array<{ path: string }> } | null>;
}

/**
 * The wired entry (`onPush: (event, env) => …` beside
 * handleUserPushEvent): the Actions side of the push family for one applied
 * delta. Never throws (the push stands — the seam's own catching wrapper).
 *
 * Per applied ref (push.go:60-260 + actionsNotifier :541-644):
 *   - created ref: the `create` event, then the `push` event (a new branch's
 *     pushNewBranch fires CreateRef :266 and PushCommits follows; a new tag
 *     fires PushCommits :120-133 BEFORE CreateRef — the order is unobservable
 *     here, both arms run);
 *   - deleted ref: the `delete` event only (the actionsNotifier skips a
 *     zero NEW id, notifier.go:543-548);
 *   - updated ref: the `push` event (an updated tag keeps upstream's
 *     zero-before payload shape, push.go:124-128).
 *
 * notify's gates (notifier_helper.go:136-172): the Actions-user cycle break
 * (:139-155 — our system id), empty/archived repos (:153-155), the unit gate
 * (:156-166), the default-branch fallback for default-branch-only events
 * (:174-185 — `delete` per github.go:31-58; wired here for delete events).
 */
export async function handleActionsPushEvent(
  env: ActionsTriggerEnv,
  event: ActionsPushEvent,
  options: { origin?: string } = {},
): Promise<void> {
  try {
    if (event.updates.length === 0) return;
    // The cycle break (notifier_helper.go:139-155): an Actions-user push
    // never re-triggers (v1 runs never push — the guard is carried).
    if (event.pusherId === ACTIONS_USER_ID) return;

    const slash = event.repo.indexOf("/");
    if (slash === -1) return;
    const owner = event.repo.slice(0, slash).toLowerCase();
    const slug = event.repo.slice(slash + 1).replace(/\.git$/, "").toLowerCase();
    const pair = await findRepositoryByPath(env.DB, owner, slug);
    if (pair === null) return;
    const repo = pair.repo;

    // archived (notifier_helper.go:153-155)
    if (repo.isArchived) return;
    // The empty-repo arm: upstream skips IsEmpty repos at notify time
    // (:153-155), but on THIS seam an isEmpty row is exactly the push-create
    // settle race — the gate's first-push settle (git-http/gate.ts:1416,
    // `SET is_empty = false WHERE is_empty = true`) commits in the RESPONSE
    // path while the engine fires this hook from waitUntil concurrently
    // (mod.ts:1315-1333, registered after the applied updates are known).
    // The hook fires ONLY for applied deltas, and every applied push on an
    // empty row is that settle's input — so reading isEmpty=true here means
    // the settle is in flight, and upstream's own first-push behavior
    // (push.go:233 sets IsEmpty=false BEFORE notify) triggers workflows on
    // it. Proceed; a settled empty repo never reaches this hook (no writer
    // re-arms the flag). The stale defaultBranch the pre-settle row carries
    // cannot mislead either: a delete event (the only default-branch-fallback
    // event here) is unreachable before the settle — there is nothing to
    // delete on a flag-fresh row.
    // The unit gate (:156-166): the repo_units actions row
    if (!(await repoActionsUnitEnabled(env.DB, repo.id))) return;

    const cell = env.REPO.getByName(engineName(repo.ownerNamespace, repo.slug));
    // The cell's read surface satisfies TriggerCellReads structurally (the
    // CommitJson/DiffResult/TreeResult shapes are supersets).
    const reads: TriggerCellReads = cell;
    const appUrl = (env.APP_URL ?? options.origin ?? event.origin ?? "").replace(/\/+$/, "");
    const triggerUserId = event.pusherId ?? repo.ownerId ?? 0;

    for (const update of event.updates) {
      // refs/pull/* never trigger (the webhook family's own filter;
      // upstream's Actions hooks fire from the user-push path only)
      if (update.ref.startsWith("refs/pull/")) continue;
      const isBranch = update.ref.startsWith("refs/heads/");
      const isTag = update.ref.startsWith("refs/tags/");
      if (!isBranch && !isTag) continue;

      const created = update.old === PUSH_ZERO_OID && update.new !== PUSH_ZERO_OID;
      const deleted = update.new === PUSH_ZERO_OID;

      if (deleted) {
        await triggerForEvent(env, pair, reads, "delete", update, appUrl, { refType: isTag ? "tag" : "branch", triggerUserId });
        continue;
      }
      if (created) {
        await triggerForEvent(env, pair, reads, "create", update, appUrl, { refType: isTag ? "tag" : "branch", triggerUserId });
      }
      await triggerForEvent(env, pair, reads, "push", update, appUrl, { refType: isTag ? "tag" : "branch", triggerUserId });
    }
  } catch (error) {
    console.error(
      `[actions-trigger] ${event.repo}: trigger pipeline failed (the applied push stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The unit gate's readback (notifier_helper.go:162-166 → UnitEnabled): the
 *  repo_units actions row's existence. */
async function repoActionsUnitEnabled(d1: D1Database, repoId: string): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ repoId: repoUnits.repoId })
    .from(repoUnits)
    .where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "actions")))
    .limit(1);
  return rows.length > 0;
}

/** RefName helpers (modules/git/ref.go). */
function refShortName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}

/** IsDefaultBranchWorkflow (github.go:29-58) for the wired family: only
 *  `delete` is default-branch-only among the events this unit feeds. */
function isDefaultBranchWorkflow(event: string): boolean {
  return event === "delete";
}

/**
 * One Actions event against one applied ref — notify's body
 * (notifier_helper.go:168-296): the default-branch fallback, the ref's tip
 * commit, the [skip ci] scan, detection, and insert+status per matched
 * workflow.
 */
async function triggerForEvent(
  env: ActionsTriggerEnv,
  pair: RepositoryWithOwner,
  reads: TriggerCellReads,
  event: TriggerEventType,
  update: { ref: string; old: string; new: string },
  appUrl: string,
  meta: { refType: string; triggerUserId: number },
): Promise<void> {
  const repo = pair.repo;
  let ref = update.ref;

  // The default-branch fallback (:174-185): a default-branch-only event
  // fired from another ref reads workflows at the default branch.
  if (refShortName(ref) !== repo.defaultBranch && isDefaultBranchWorkflow(event)) {
    ref = `refs/heads/${repo.defaultBranch}`;
  }

  const commit = await reads.readCommit(update.new);
  if (commit === null) {
    console.error(`[actions-trigger] ${repo.ownerNamespace}/${repo.slug}: tip commit ${update.new} unreadable — ${event} skipped`);
    return;
  }

  // [skip ci] (:198-200) — the commit-message surface (the PR-title surface
  // arms with the PR producer).
  if (skipWorkflows(event, commit.message, null)) return;

  // Detection (:202-212): enumerate + extract + match.
  const filesChangedCache: { value: string[] | null } = { value: undefined as unknown as string[] | null };
  const filesChanged = async (): Promise<string[] | null> => {
    if (filesChangedCache.value !== undefined) return filesChangedCache.value;
    const diff = update.old === PUSH_ZERO_OID ? null : await reads.readDiff(update.old, update.new);
    const value = diff === null ? null : diff.files.map((f) => f.path);
    filesChangedCache.value = value;
    return value;
  };

  const workflowFiles = await listWorkflows(reads, ref);
  const matched: Array<{ file: WorkflowFile; evt: WorkflowEvent }> = [];
  const filtered: Array<{ file: WorkflowFile; evt: WorkflowEvent }> = [];
  const invalid: Record<string, InvalidWorkflowParseError> = {};
  for (const file of workflowFiles) {
    let events: WorkflowEvent[];
    try {
      // The static scan first (readWorkflowEvents' order — ValidateWorkflowStatic
      // runs before the events arm, workflows.go:128-137): a context violation
      // is the STATIC error arm — it feeds the failed-run arm below and never
      // matches. The scan's extraction is inside the try so an unreadable
      // document falls to the same non-static log-and-skip as the `on:` arm.
      const { runName, jobIfs } = staticExpressionsOf(file.content);
      const problem = validateStaticExpressions({ runName, jobIfs });
      if (problem !== null) {
        invalid[file.entryName] = problem;
        continue;
      }
      events = getEventsFromContent(file.content);
    } catch (err) {
      // upstream logs and skips (:203-207); the non-static arm — the
      // YAML-model half of ValidateWorkflowStatic stages with the E-tier
      // model port (the module header).
      console.error(
        `[actions-trigger] ${repo.ownerNamespace}/${repo.slug}: ignore invalid workflow ${file.entryName}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const evt of events) {
      if (evt.schedules !== null) continue; // schedules stage (§1.4)
      const result = detectWorkflowMatch(event, { ref: update.ref, before: update.old, after: update.new }, evt, await filesChanged());
      if (result === "matched") matched.push({ file, evt });
      else if (result === "filteredOut") filtered.push({ file, evt });
    }
  }

  // The disabled-workflow skip (:222-231)
  const cfg = await loadRepoActionsConfig(env.DB, repo.id);
  const isDisabled = (entryName: string): boolean => cfg.disabledWorkflows.includes(entryName);

  const eventPayloadJson = await buildPushEventPayload(event, update, commit, meta, appUrl, reads);

  // handleInvalidWorkflows (notifier_helper.go:284-286's push gate over
  // invalid_workflow.go:20-45 — the disabled-workflow skip lives inside the
  // landed arm): each static-validation failure records a FAILED RUN whose
  // summary carries the error verbatim. Upstream order: the invalid arm runs
  // before handleWorkflows and handleFilteredWorkflows.
  if (event === "push") {
    await handleInvalidWorkflows(
      env.DB,
      {
        repoId: repo.id,
        ownerId: repo.ownerId ?? 0,
        doerId: meta.triggerUserId,
        ref,
        commitSha: commit.oid,
        commitTitle: commit.subject,
        event,
        eventPayload: eventPayloadJson,
      },
      invalid,
    );
  }

  for (const { file } of matched) {
    if (isDisabled(file.entryName)) continue;
    // The staged E5 insert gate (module header): a workflow whose jobs
    // carry `strategy.matrix` inserts NO run — the combo expansion needs
    // the YAML workflow model port. Every other expression surface (run-
    // name, job `if:`, workflow-level concurrency) is evaluated below;
    // step-level `${{` rides the payload verbatim (runner-side upstream
    // too — §D3).
    let split: SingleJobPayload[];
    try {
      split = splitWorkflowPayloads(file.content);
    } catch (err) {
      // handleWorkflows logs and continues (:357-361)
      console.error(
        `[actions-trigger] ${repo.ownerNamespace}/${repo.slug}: insert ${file.entryName} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (split.some((job) => job.hasMatrix)) continue;
    try {
      await insertTriggeredRunSplit(
        env.DB,
        {
          repoId: repo.id,
          ownerId: repo.ownerId ?? 0,
          workflowId: file.entryName,
          triggerUserId: meta.triggerUserId,
          ref,
          commitSha: commit.oid,
          isForkPullRequest: false,
          event,
          eventPayloadJson,
          triggerEvent: event,
          title: commit.subject,
          repoOwnerNamespace: repo.ownerNamespace,
          repoSlug: repo.slug,
          appUrl,
        },
        split,
        readWorkflowRawConcurrency(file.content),
      );
    } catch (err) {
      // handleWorkflows logs and continues (:357-361)
      console.error(
        `[actions-trigger] ${repo.ownerNamespace}/${repo.slug}: insert ${file.entryName} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // handleFilteredWorkflows (:437-456): the skipped-status arm — required
  // contexts only, fork-PR polarity staged with the PR producer.
  if (filtered.length > 0) {
    const requiredGlobs = await requiredStatusContextGlobs(env.DB, repo.id);
    for (const { file, evt } of filtered) {
      if (isDisabled(file.entryName)) continue;
      try {
        await createSkippedCommitStatusForFilteredWorkflow(env.DB, {
          repoId: repo.id,
          event,
          triggerEvent: evt.name,
          workflowId: file.entryName,
          content: file.content,
          payloadJson: eventPayloadJson,
          requiredGlobs,
        });
      } catch (err) {
        console.error(
          `[actions-trigger] ${repo.ownerNamespace}/${repo.slug}: skipped status ${file.entryName} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * The stored event payload (api.PushPayload JSON, hook.go:154-176): the
 * identity fields the claim context reads (github.event) and the commit
 * status arm needs (head_commit.id). The commit list is the capped walk in
 * upstream's rev-list order (newest-first, push.go:186-191); compare_url
 * carries the ComposeCompareURL shape (push.go:258-287 — the zero-before
 * fallback walks to the oldest commit's first parent; an unborn base renders
 * ""). The repository/pusher objects stay minimal ({}-shaped) — the claim
 * context reads them through its own dedicated fields; the full webhook
 * identity objects ride the webhook family's payloads.
 */
async function buildPushEventPayload(
  event: TriggerEventType,
  update: { ref: string; old: string; new: string },
  commit: { oid: string; subject: string; message: string; parents: string[]; author: { name: string; email: string }; committer: { name: string; email: string } },
  meta: { refType: string },
  appUrl: string,
  reads: TriggerCellReads,
): Promise<string> {
  if (event === "delete") {
    return JSON.stringify({
      ref: refShortName(update.ref),
      ref_type: meta.refType,
      pusher_type: "user",
    });
  }
  if (event === "create") {
    return JSON.stringify({
      sha: update.new,
      ref: refShortName(update.ref),
      ref_type: meta.refType,
    });
  }
  // The capped commit walk: an updated ref reads the old..new range
  // (pushUpdateBranch's CommitsBeforeUntil, push.go:289-293); a created ref
  // reads the tip's ancestor chain capped at 10 (pushNewBranch's
  // CommitsBeforeLimit(10), push.go:264-266). Both arrive newest-first and
  // feed the payload in that order (upstream's rev-list order).
  const walked: Array<{ oid: string; parents: string[]; subject: string; message: string; author: { name: string; email: string }; committer: { name: string; email: string } }> =
    update.old !== PUSH_ZERO_OID
      ? (await reads.listCommitsRange(update.old, update.new, FEED_MAX_COMMIT_NUM))?.commits.slice().reverse() ?? []
      : (await reads.listLog(update.new, { ofs: 0, n: 10 }))?.commits ?? [];
  const commits = walked.map((c) => ({
    id: c.oid,
    message: c.message,
    url: "",
    author: c.author,
    committer: c.committer,
    added: [],
    removed: [],
    modified: [],
    timestamp: null,
    verification: null,
  }));
  // getCompareURL (push.go:258-287): zero old → the oldest walked commit's
  // first parent; still zero → "" (an unborn base renders no compare URL).
  let baseForCompare = update.old === PUSH_ZERO_OID ? "" : update.old;
  if (baseForCompare === "" && walked.length > 0) {
    const oldest = walked[walked.length - 1]!;
    baseForCompare = oldest.parents[0] ?? "";
  }
  const compareUrl = baseForCompare === "" ? "" : `${appUrl}/compare/${baseForCompare}...${update.new}`;
  return JSON.stringify({
    ref: update.ref,
    before: update.old,
    after: update.new,
    compare_url: compareUrl,
    commits,
    total_commits: walked.length,
    head_commit: {
      id: commit.oid,
      message: commit.message,
      url: "",
      author: commit.author,
      committer: commit.committer,
      added: [],
      removed: [],
      modified: [],
      timestamp: null,
    },
    repository: {},
    pusher: {},
    sender: {},
  });
}
