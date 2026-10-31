/**
 * The Actions trigger chain — SPEC-0012 M3 tier P (the §D5 decomposition's
 * PURE-PARITY rows, the OQ-1 decision record's D1-D6): everything upstream's
 * push-family trigger does that needs NO expression machinery, ported from
 * the pin fc4936884584a41931906553d96c2601d750e6ef.
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
 *   `insertTriggeredRun` (services/actions/run.go:63-217's P slice: run index
 *   :67, per-job payload split, waiting/pending statuses :217-231, the
 *   task-version bump :159-165) → commit statuses
 *   (services/actions/commit_status.go:31-63 + the skipped-status arm :218-297)
 *   → the needs-graph emitter pass (services/actions/job_emitter.go's
 *   checkJobsOfCurrentRunAttempt :93-201 + jobStatusResolver :444-548, the
 *   implicit-success skip arm services/actions/helper.go:158-160) — and the
 *   claim-payload `if: always()` rewrite (services/actions/task.go:176-186)
 *   served by dispatch at claim time.
 *
 * ## The staged boundary (what P does NOT do, per §D5's staging sentence)
 *
 *   - The `${{` byte scan is the insert gate (workflows.go:134's own
 *     classification arm): a workflow whose CONTENT carries `${{` matches
 *     detection (upstream matches it too — the matchers run on raw strings)
 *     but inserts NO run; it waits for the E tier. Recorded as the
 *     visible-error posture of a P-only staging, not an invented rejection.
 *   - The S-tier seam is WIRED: the detection loop runs the landed
 *     `expression-syntax` wrapper's static scan (validate.go:47-62's two
 *     context arms — the YAML-model half of ValidateWorkflowStatic, :22-46,
 *     stages with the E-tier model port) and a context violation feeds the
 *     landed `invalid-workflow` failed-run arm (invalid_workflow.go:20-45,
 *     gated notifier_helper.go:284-286, disabled-skip inside). A workflow
 *     whose `on:` node fails to parse stays on the log-and-skip arm —
 *     upstream's NON-static classification (workflows.go:202-207), never a
 *     failed run.
 *   - E-tier rows (run-name/static-matrix interpolation, the job `if:`
 *     evaluation decideJobIf helper.go:132-144, concurrency, deferred-matrix
 *     expansion) stay staged; the emitter's non-empty-`if:` arm defaults to
 *     START (the disclosed P divergence — upstream decides; §D2 #8).
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
 *     `repo_counters.run_index` (SPEC §4.5) — the column is a HANDOFF
 *     (src/db/schema.ts is outside this unit's ownership). Interim:
 *     MAX(index)+1 per repo with UNIQUE(repo_id, index) arbitrating races
 *     (model.ts's own M1a note names exactly this arbitration); swap
 *     `nextRunIndex` to the counter CAS when the column lands.
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
 *     its module header names the anchor) call it directly.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { parseDocument, Document, YAMLMap, isMap, isScalar, isSeq, type Node as YamlNode } from "yaml";

import {
  actionRunAttempts,
  actionRunJobs,
  actionRuns,
  commitStatuses,
  repoUnits,
  repositories,
} from "../../db/schema";
import { findRepositoryByPath, type RepositoryWithOwner } from "../../api/services/repository";
import { engineName } from "../../repos/service";
import { listRepoRules, parseRuleConfig, type ProtectedBranchRow } from "../branch-protection";
import { loadRepoActionsConfig } from "./config";
import { validateStaticExpressions } from "./expression-syntax";
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
 * The P-tier readWorkflowEvents: the `on:` extraction only. The S-tier's
 * ValidateWorkflowStatic pass (upstream's first arm, the failed-run feed)
 * stages behind the sibling's wrapper; the `${{` byte scan (:134) is the
 * insert gate — a workflow carrying it is skipped at insert (the module
 * header's staged boundary). A malformed `on:` node raises (the caller logs
 * and skips — upstream's non-static branch, workflows.go:202-207).
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
 * The jobparser.Parse P slice over an expression-free workflow: one
 * SingleWorkflow per job (no matrix combos — the E-tier owns
 * buildMatrixCombos; a `strategy.matrix` here stays the placeholder shape).
 * Throws on a malformed jobs mapping (upstream "invalid jobs" → no run).
 */
export function splitWorkflowPayloads(content: string): SingleJobPayload[] {
  const doc = parseDocument(content);
  const jobs = doc.get("jobs", true) as YamlNode | undefined;
  if (jobs === undefined || !isMap(jobs)) {
    throw new Error("invalid jobs");
  }
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
    // EraseNeeds (run.go:196-201): the payload never carries needs.
    jobNode.delete("needs");
    // The payload's name: carries the resolved display name (buildMatrixCombos'
    // combo.Name = jobName(...), stored verbatim for expression-free content).
    jobNode.set("name", displayName);
    const strategyNode = mapGet(jobNode, "strategy");
    const rawIf = typeof scalarValue(mapGet(jobNode, "if")) === "string" ? String(scalarValue(mapGet(jobNode, "if"))) : "";
    out.push({
      jobId,
      name: displayName,
      needs,
      runsOn,
      maxParallel: parseMaxParallel(isMap(strategyNode) ? strategyNode : undefined),
      continueOnError: parseContinueOnError(jobNode),
      rawIf,
      payload: marshalSingleJob(doc, jobId, jobNode),
    });
  }
  return out;
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
 * The per-repo run index. Upstream: the `action_run_index` named sequence via
 * GetNextResourceIndex (models/db/index.go:115-168) inside the insert
 * transaction; the SPEC §4.5 mapping is `repo_counters.run_index` — a column
 * this unit's ownership does not cover (HANDOFF). The interim reads
 * MAX(index)+1 per repo; UNIQUE(repo_id, index) on action_runs arbitrates a
 * race (the loser's insert fails and `insertTriggeredRun` retries once),
 * which the landed model.ts M1a note names as exactly this arbitration.
 * SWAP POINT: the counter CAS replaces the body, the signature stands.
 */
export async function nextRunIndex(d1: D1Database, repoId: string): Promise<number> {
  const db = drizzle(d1);
  const rows = await db
    .select({ value: sql<number>`coalesce(max(${actionRuns.index}), 0)` })
    .from(actionRuns)
    .where(eq(actionRuns.repoId, repoId));
  return Number(rows[0]?.value ?? 0) + 1;
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
 * The P-tier PrepareRunAndInsert+InsertRun (run.go:64-217): run index, run
 * row (waiting), attempt-1 row, per-job payload split, job statuses
 * (waiting; PENDING when it has needs — run.go:214-216), the task-version
 * bump when a dispatchable waiting job exists (run.go:159-165 via the model),
 * commit statuses (:45-52 via CreateCommitStatusForRunJobs), and the
 * emitter pass (run.go:172-178's post-commit kick, inline per the
 * module-header adaptation).
 *
 * The E-tier arms are absent by design: run-name interpolation (run.go:121-127),
 * workflow/job concurrency (run.go:101, 185), the `if:` gate (decideJobIf,
 * helper.go:132-144), matrix combos. An insert failure (a malformed jobs
 * mapping) propagates — upstream's parse error aborts the insert and
 * handleWorkflows logs-and-continues to the next workflow (:357-361).
 */
export async function insertTriggeredRun(
  d1: D1Database,
  input: TriggeredRunInput,
  workflowContent: string,
): Promise<TriggerRunOutcome> {
  const split = splitWorkflowPayloads(workflowContent);
  return insertTriggeredRunSplit(d1, input, split);
}

/**
 * The insert half split from the payload split so the emitter's re-entry and
 * tests can drive a pre-computed split (upstream Parse then InsertRun).
 */
export async function insertTriggeredRunSplit(
  d1: D1Database,
  input: TriggeredRunInput,
  split: SingleJobPayload[],
): Promise<TriggerRunOutcome> {
  const db = drizzle(d1);
  const now = new Date();

  // Attempt 1..N retries on the UNIQUE(index) race the interim allocator
  // documents; two races on one repo in one second is the pathological case.
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

      // insertRunJob's status arm (run.go:214-216): waiting; PENDING while it
      // has needs ("past the run's own holds, a job is Pending exactly while
      // its needs are unfinished" — job_emitter.go:915). attempt_job_id
      // allocates 1..N per attempt (GetNextAttemptJobID).
      const jobValues = split.map((job, i) => ({
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
        status: job.needs.length > 0 ? ACTION_STATUS_PENDING : ACTION_STATUS_WAITING,
        maxParallel: job.maxParallel,
        continueOnError: job.continueOnError,
        runAttemptId: runAttempt.id,
        attemptJobId: i + 1,
        created: now,
        updated: now,
      }));
      const jobRows: RunJobRow[] = [];
      const CHUNK = 2; // the ~40-column bind cap (model.ts's idiom)
      for (let i = 0; i < jobValues.length; i += CHUNK) {
        const chunk = jobValues.slice(i, i + CHUNK);
        if (chunk.length === 0) continue;
        const rows = await db.insert(actionRunJobs).values(chunk).returning();
        jobRows.push(...rows);
      }

      // AggregateJobStatus (run.go:233-234) — the attempt settles to its jobs'
      // aggregate (all pending → still "running-shaped" upstream; the v1
      // insert is all-waiting or all-pending, so the aggregate is waiting).
      const attemptStatus = aggregateJobStatus(jobRows.map(toAggregateJob));
      await db
        .update(actionRunAttempts)
        .set({ status: attemptStatus, updated: now })
        .where(eq(actionRunAttempts.id, runAttempt.id));
      await db.update(actionRuns).set({ status: attemptStatus, updated: now }).where(eq(actionRuns.id, run.id));

      // if there is a job in the waiting status, increase tasks version
      // (run.go:157-165; a reusable caller never counts — no callers in v1).
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

      // The emitter pass (run.go:172-178's post-commit kick) — the needs-free
      // jobs are already waiting, so the pass resolves pending needs-chains
      // whose needs are ALL satisfied-by-absence... it resolves nothing new
      // here (nothing finished yet); kept for shape parity and for the
      // all-pending run (no waiting job exists → no runner wake needed).
      return { run, jobs: jobRows };
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

      // The `if:` gate: empty → implicit success() — true iff every need
      // finished as Success (helper.go:158-160). A non-empty `if:` is the
      // E-tier evaluation (decideJobIf helper.go:132-144) — P defaults to
      // start (the module-header divergence).
      const shouldStartJob = jobRawIf(job) === "" ? allSucceed : true;
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

  // createCommitStatusesForJobsByRun (job_emitter.go:135-151): the resolved
  // jobs' statuses re-post.
  const repoRecord = (
    await db
      .select({ ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
      .from(repositories)
      .where(eq(repositories.id, run.repoId))
      .limit(1)
  )[0];
  await createCommitStatusForRunJobs(
    d1,
    {
      run,
      repoOwnerNamespace: repoRecord?.ownerNamespace ?? "",
      repoSlug: repoRecord?.slug ?? "",
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

  for (const { file } of matched) {
    if (isDisabled(file.entryName)) continue;
    // The `${{` gate (workflows.go:134's classification, staged as the P
    // insert boundary — the module header): expression-ful content waits
    // for the E tier.
    if (containsExpression(file.content)) continue;
    try {
      await insertTriggeredRun(
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
        file.content,
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
