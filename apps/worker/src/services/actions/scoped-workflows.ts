/**
 * The scoped-workflows substrate's PURE layer — the v1.3.2 board's P1-3 /
 * census C10 (docs/residuals-v1.3.2.md P1-3, P2-3): everything upstream's
 * scoped-workflows feature does with strings, forms and arrays that does
 * NOT need the store table or the workflow YAML model. Ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef.
 *
 * ## The verified dependency map (the board's "needs its SPEC-attachment
 * first / post-M3" verdict, decomposed against the pin)
 *
 * Upstream's scoped workflows let an owner (user/org) or the instance
 * register a repository as a WORKFLOW SOURCE: workflow files under the
 * source's `SCOPED_WORKFLOW_DIRS` (default `.gitea/scoped_workflows`,
 * modules/setting/actions.go:41,53 — the dir may be empty = feature
 * disabled, and must never overlap WORKFLOW_DIRS, actions.go:147-158) run
 * on EVERY repository the scope covers, in the consuming repo's own
 * context (the locale strings' desc_user/desc_org/desc_global,
 * options/locale/locale_en-US.json `actions.scoped_workflows.desc_*`).
 * The store is `action_scoped_workflow_source` (models/actions/
 * scoped_workflow.go:18-41 — OwnerID 0 = instance-level, SourceRepoID,
 * WorkflowConfigs JSON of `{required, patterns[]}` per workflow entry,
 * :34-38) and the settings pages over it are THREE scopes of one shared
 * handler set (routers/web/shared/actions/scoped_workflows.go:98-368 —
 * ScopedWorkflows GET / ScopedWorkflowAdd / ScopedWorkflowSetRequired /
 * ScopedWorkflowRemove), mounted at web.go:517-523's
 * `addSettingsScopedWorkflowsRoutes` inside the user (:730), org (:1060)
 * and admin (:903) groups, rendering
 * templates/shared/actions/scoped_workflows.tmpl.
 *
 * What each piece of that feature actually depends on — verified, not
 * assumed:
 *
 *   - THE MERGE-GATE INTEGRATION (why the feature exists: a required
 *     scoped workflow's status patterns gate consuming merges) rides the
 *     RUN PIPELINE — commit statuses posted by scoped runs (services/
 *     actions/commit_status.go:50-68,142-148 — the scopedPrefix context
 *     arm), pull.go:273,419-436 (EffectiveRequiredContexts = branch
 *     protection + required scoped checks), rerun.go:91-98, and the
 *     trigger chain that produces scoped runs (notifier_helper.go:813,
 *     workflows.go:259). That chain is SPEC-0012's M3 (the board's P1-1;
 *     the census C10 row defers the pages "post-M3"). STAGED.
 *   - THE WORKFLOW-FILE PARSER (services/actions/scoped_workflow_cache.go:
 *     39-70 LoadParsedScopedWorkflows → modules/actions/
 *     scoped_workflows.go:31-58 ParseScopedWorkflows) decodes each source
 *     file's `name:` (WorkflowDisplayName, workflows.go:148-158) and
 *     `on:` events (GetEventsFromContent, workflows.go:123-133) — both
 *     ride jobparser, and the YAML model port is a named M3 milestone row
 *     (the board's P1-1; SPEC-0012 §7's milestone table). STAGED behind
 *     M3's port; the engine reads it needs (listTree/readBlob at the
 *     default-branch HEAD) already exist client-side (ui/engine.ts:54-55,
 *     the repo-actions-workflow.ts WorkflowFileReads seam).
 *   - THE STORE needs a D1 home — upstream's `action_scoped_workflow_source`
 *     has NO landed table (the migrations end at 0046; the only scoped
 *     column is action_runs.is_scoped_run, schema.ts:3664, unread in v1
 *     per SPEC-0012 §1.4). The schema + migration are a HANDOFF (this
 *     unit's ownership excludes src/db/schema.ts). STAGED.
 *   - THE SETTINGS PAGES need the store (every arm reads/writes the
 *     source rows) and the parser (the GET list arm renders parsed files,
 *     scoped_workflows.go:197-243; SetRequired re-parses for the live
 *     set, :304-320). The routes are a ui/index.ts HANDOFF. STAGED — the
 *     landed reduction stands until both substrates exist (the admin
 *     actions runners module's feasibility note — "faking it would
 *     violate the feasibility discipline"; pages/org-settings-actions.tsx
 *     and the shared nav keep the Scoped-workflows items unrendered, the
 *     dead-link rule).
 *   - THE PURE LAYER — this module — is independent of ALL of the above:
 *     the path predicate, the status-context name shapes, the
 *     status-producing event allowlist, the patterns-textarea split, the
 *     required-form's config semantics and the settings page's view-model
 *     merge (live rows + orphans). These are verbatim ports of upstream's
 *     own string/array code, parameterized over the store rows and parsed
 *     files so the staged pages consume them unchanged once the store
 *     (HANDOFF) and the YAML model (M3) land.
 *
 * ## The parameterization seam (the one deliberate divergence)
 *
 * Upstream's `listSourceScopedWorkflowFiles` (routers/web/shared/actions/
 * scoped_workflows.go:197-243) parses source files IN PLACE and derives
 * each workflow's expected commit-status contexts there
 * (`deriveScopedStatusContexts`, :165-195 — a jobparser.Parse of every
 * job, matrix-expanded). Both halves are M3-gated, so `buildScopedWorkflowInfos`
 * takes the parsed rows (`{entryName, displayName, contexts}`) as INPUT —
 * the future LoadParsedScopedWorkflows port supplies them and the staged
 * page arm renders them unchanged; the contexts derivation plugs into the
 * same seam (`deriveScopedStatusContexts`' shape is documented on the
 * input field). Everything else in this module is upstream verbatim.
 */

// ---------------------------------------------------------------------------
// The dirs (modules/setting/actions.go:41,53,147-158)
// ---------------------------------------------------------------------------

/** `setting.Actions.ScopedWorkflowDirs`' default (actions.go:53 — the
 *  repo-actions WORKFLOW_DIRS twins' sibling, repo-actions-runs.tsx:395).
 *  Upstream also honors `.github/scoped_workflows` when configured, and an
 *  EMPTY configured list disables the feature entirely (actions.go:147-158
 *  — which additionally rejects any overlap with WORKFLOW_DIRS, so one
 *  file can never run both repo-level and scope-level). The landed worker
 *  carries no SCOPED_WORKFLOW_DIRS var yet — the default IS the effective
 *  list until a config surface lands. */
export const SCOPED_WORKFLOW_DIRS = [".gitea/scoped_workflows"];

/**
 * `isWorkflowInDirs`' scoped half (modules/actions/workflows.go:62-70 —
 * the `IsWorkflowOrScopedWorkflow` or-twin's second arm, :58-60): the path
 * must end .yml/.yaml AND live directly under one of the scoped dirs
 * (HasPrefix `dir + "/"`). `dirs` defaults to the landed default list;
 * an empty list (the feature-disabled configuration) answers false for
 * everything, upstream's exact posture.
 */
export function isScopedWorkflowPath(path: string, dirs: readonly string[] = SCOPED_WORKFLOW_DIRS): boolean {
  if (!path.endsWith(".yaml") && !path.endsWith(".yml")) {
    return false;
  }
  for (const dir of dirs) {
    if (path.startsWith(`${dir}/`)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The commit-status context shapes (models/actions/scoped_workflow.go:
// 100-106 + modules/actions/workflows.go:156-171)
// ---------------------------------------------------------------------------

/**
 * `ScopedStatusContextPrefix` (models/actions/scoped_workflow.go:101-106)
 * — the source-repo prefix that makes a scoped run's contexts distinct
 * from same-named repo-level workflows: the source repo's FullName, or
 * `scoped:<id>` when the repo row is gone (upstream's GetRepositoryByID
 * miss arm). The repo lookup itself stays with the caller (this unit does
 * not own a repo store read); null IS that miss.
 */
export function scopedStatusContextPrefix(sourceRepoFullName: string | null, sourceRepoId: number): string {
  if (sourceRepoFullName !== null) {
    return sourceRepoFullName;
  }
  return `scoped:${sourceRepoId}`;
}

/**
 * `WorkflowStatusContextName` (workflows.go:159-162): "<display> / <job>
 * (<event>)", TrimSpace'd — the repo-level workflow job's status context.
 */
export function workflowStatusContextName(displayName: string, jobName: string, event: string): string {
  return trimSpaces(`${displayName} / ${jobName} (${event})`);
}

/**
 * `ScopedWorkflowStatusContextName` (workflows.go:163-166): the scoped
 * run's context — "<prefix>: <repo-level shape>", set off by a colon so a
 * source repo's `deploy` can never collide with a consuming repo's own.
 * The settings page's expected-contexts preview (the shared template's
 * `data-context` rows, scoped_workflows.tmpl:64) derives the SAME string.
 */
export function scopedWorkflowStatusContextName(prefix: string, displayName: string, jobName: string, event: string): string {
  return trimSpaces(`${prefix}: ${workflowStatusContextName(displayName, jobName, event)}`);
}

/** Go's strings.TrimSpace (workflows.go:160/165's Suffix trim) — JS
 *  `.trim()` over the same practical class for these inputs (form and
 *  YAML name fields; the exotic NEL rune where the two grammars disagree
 *  cannot appear in either source). */
function trimSpaces(s: string): string {
  return s.trim();
}

/**
 * `ShouldEventCreateCommitStatus` (workflows.go:168-179): whether a run
 * triggered by this `on:` event posts a commit status, so its context can
 * serve as a required check (workflow_dispatch/schedule post none — the
 * settings page's contexts derivation filters on this, scoped_workflows.go:172-175).
 * The upstream TODO travels with the port: the allowlist duplicates the
 * truth in services/actions.getCommitStatusEventNameAndCommitID and the
 * two are kept in sync by hand.
 */
export function shouldEventCreateCommitStatus(event: string): boolean {
  switch (event) {
    case "push":
    case "pull_request":
    case "pull_request_target":
    case "pull_request_review":
    case "pull_request_review_comment":
    case "release":
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The store row's config + the settings page's view model (models/actions/
// scoped_workflow.go:34-38 + routers/web/shared/actions/scoped_workflows.go:
// 83-90,197-243)
// ---------------------------------------------------------------------------

/** `ScopedWorkflowConfig` (models/actions/scoped_workflow.go:34-38) — one
 *  workflow's merge-gate config within a source registration: required
 *  (a required workflow cannot be disabled by consumer repos — the locale
 *  `actions.scoped_workflows.required.label` line) and the status-check
 *  patterns (globs, one per line; only effective while required). */
export interface ScopedWorkflowConfig {
  required: boolean;
  patterns: string[];
}

/** `scopedWorkflowInfo` (routers/web/shared/actions/scoped_workflows.go:
 *  83-90) — one workflow row on the settings page. `patterns` is the
 *  newline-joined STORED patterns (kept even when not required, as
 *  history — the upstream comment on the field). `missing` marks an
 *  orphan: the stored config's workflow file is gone from the source
 *  default branch, and a REQUIRED orphan still gates merges
 *  (must-present), so it must stay visible and clearable — upstream's
 *  orphan comment, :224-226. */
export interface ScopedWorkflowInfo {
  entryName: string;
  displayName: string;
  required: boolean;
  patterns: string;
  contexts: string[];
  missing: boolean;
}

/** One parsed source workflow as the staged LoadParsedScopedWorkflows
 *  port will supply it (upstream's `ParsedScopedWorkflow`,
 *  modules/actions/scoped_workflows.go:22-28, with the settings page's
 *  contexts derivation already applied). An empty array is BOTH upstream
 *  arms that produce no live rows: an empty source (the `repo.IsEmpty`
 *  skip, scoped_workflows.go:203) and a parse failure (the log.Error
 *  fall-through, :205-207 — configs then surface as orphans). */
export interface ParsedScopedWorkflowFile {
  entryName: string;
  displayName: string;
  contexts: string[];
}

/**
 * `listSourceScopedWorkflowFiles` (scoped_workflows.go:197-243), the git
 * parse lifted out: live rows from the parsed files (the stored config's
 * required/patterns merged in, :214-217), then ORPHAN rows for stored
 * configs whose workflow file is no longer parsed (an entry whose config
 * value is null never renders — upstream's `cfg == nil` skips, :229),
 * entry-name-sorted for a stable page (the map-iteration-order comment,
 * :240-241), live rows first in parse order.
 */
export function buildScopedWorkflowInfos(
  parsed: readonly ParsedScopedWorkflowFile[],
  configs: Readonly<Record<string, ScopedWorkflowConfig | null>>,
): ScopedWorkflowInfo[] {
  const rendered = new Set<string>();
  const files: ScopedWorkflowInfo[] = parsed.map((p) => {
    const cfg = configs[p.entryName];
    rendered.add(p.entryName);
    return {
      entryName: p.entryName,
      displayName: p.displayName,
      required: cfg?.required ?? false,
      patterns: (cfg?.patterns ?? []).join("\n"),
      contexts: p.contexts,
      missing: false,
    };
  });

  const orphans: ScopedWorkflowInfo[] = [];
  for (const [name, cfg] of Object.entries(configs)) {
    if (cfg === null || cfg === undefined || rendered.has(name)) {
      continue;
    }
    orphans.push({
      entryName: name,
      displayName: name,
      required: cfg.required,
      patterns: cfg.patterns.join("\n"),
      contexts: [],
      missing: true,
    });
  }
  orphans.sort((a, b) => (a.entryName < b.entryName ? -1 : a.entryName > b.entryName ? 1 : 0));
  return [...files, ...orphans];
}

// ---------------------------------------------------------------------------
// The settings form semantics (routers/web/shared/actions/
// scoped_workflows.go:152-160 parsePatternLines + :322-342 SetRequired's
// config build)
// ---------------------------------------------------------------------------

/**
 * `parsePatternLines` (scoped_workflows.go:152-160): a patterns textarea's
 * value → the trimmed, non-empty patterns (one per line).
 */
export function parsePatternLines(raw: string): string[] {
  const patterns: string[] = [];
  for (const line of raw.split("\n")) {
    const p = line.trim();
    if (p !== "") {
      patterns.push(p);
    }
  }
  return patterns;
}

/** The SetRequired arm's outcomes: the rebuilt config map, or upstream's
 *  JSONError refusal (`actions.scoped_workflows.required.patterns_empty` —
 *  "Each required workflow needs at least one status check pattern."). */
export type ScopedWorkflowRequiredOutcome =
  | { outcome: "saved"; configs: Record<string, ScopedWorkflowConfig> }
  | { outcome: "patterns-empty" };

/**
 * `ScopedWorkflowSetRequired`'s config build (scoped_workflows.go:322-342)
 * — the page submits every workflow row's id in `workflow_ids`, its
 * patterns in `required_patterns[<id>]` (one per line), and the checked
 * rows' ids in `required_workflow_ids`; `liveSet` is the source default
 * branch's parsed entry names (upstream builds it from
 * LoadParsedScopedWorkflows, :304-320 — an empty source yields the empty
 * set, :311-312). Semantics, upstream verbatim, in submission order:
 *   - a checked row with no pattern REFUSES the whole save
 *     (patterns-empty, :333-336 — fail-fast on the first offender);
 *   - a required row keeps `{required: true}` (patterns non-empty by the
 *     refusal above);
 *   - an unchecked row keeps `{required: false}` only while it is LIVE
 *     and carries at least one stored pattern (:339 — kept as history);
 *   - an unchecked ORPHAN (file gone) DROPS — the only escapes from a
 *     required orphan are clearing it here or removing the whole source
 *     (the orphan comment, :224-226).
 */
export function applyScopedWorkflowRequiredForm(
  workflowIds: readonly string[],
  requiredIds: readonly string[],
  patternsByWorkflowId: Readonly<Record<string, string>>,
  liveSet: ReadonlySet<string>,
): ScopedWorkflowRequiredOutcome {
  const requiredSet = new Set(requiredIds);
  const configs: Record<string, ScopedWorkflowConfig> = {};
  for (const workflowId of workflowIds) {
    const patterns = parsePatternLines(patternsByWorkflowId[workflowId] ?? "");
    const required = requiredSet.has(workflowId);
    if (required && patterns.length === 0) {
      return { outcome: "patterns-empty" };
    }
    if (required || (liveSet.has(workflowId) && patterns.length > 0)) {
      configs[workflowId] = { required, patterns };
    }
  }
  return { outcome: "saved", configs };
}
