/**
 * The SCOPED-WORKFLOWS settings surface — the v1.3.2 board's P1-3 staged
 * pages (census C10), ported from the pin fc4936884584a41931906553d96c2601d750e6ef.
 * ONE shared handler set + ONE shared template serve THREE scopes (upstream's
 * own shape — `getScopedWorkflowsCtx`'s three arms), so this module is the
 * scope-neutral core and pages/org-settings-actions-scoped-workflows.tsx,
 * pages/user-settings-actions-scoped-workflows.tsx and
 * pages/admin-actions-scoped-workflows.tsx render only their frames (the
 * owner-general twins' reuse split).
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - `routers/web/web.go:517-523` — `addSettingsScopedWorkflowsRoutes`, the
 *     shared four-route group `m.Group("/scoped-workflows")`: `GET ""`
 *     `shared_actions.ScopedWorkflows`, `POST /add` `ScopedWorkflowAdd`,
 *     `POST /required` `ScopedWorkflowSetRequired`, `POST /remove`
 *     `ScopedWorkflowRemove`. Mounted inside the USER group (web.go:730, the
 *     reqSignIn `/user/settings/actions` group behind
 *     `actions.MustEnableActions`), the ADMIN group (web.go:903, behind
 *     `adminReq`) and the ORG group (web.go:1060, the `/{org}/settings`
 *     subtree behind `actions.MustEnableActions`).
 *   - `routers/web/shared/actions/scoped_workflows.go` — the handlers:
 *     `getScopedWorkflowsCtx` (:44-80 — OwnerID / IsOrg|IsUser|IsGlobal /
 *     RedirectLink / SearchUID per scope), `ScopedWorkflows` (:98-149 —
 *     Title `actions.scoped_workflows`, the per-scope desc_*, the sources'
 *     repo+infos views, the search-box data, ScopedWorkflowDirs joined ", "),
 *     `ScopedWorkflowAdd` (:245-280), `ScopedWorkflowSetRequired`
 *     (:282-349), `ScopedWorkflowRemove` (:351-368),
 *     `listSourceScopedWorkflowFiles` (:197-243 — the live+orphan merge),
 *     `deriveScopedStatusContexts` (:162-195 — the expected-contexts
 *     preview). The pure string/form/array halves of those arms are the
 *     LANDED substrate services/actions/scoped-workflows.ts (`e24455c` —
 *     buildScopedWorkflowInfos / applyScopedWorkflowRequiredForm /
 *     parsePatternLines / shouldEventCreateCommitStatus /
 *     scopedWorkflowStatusContextName / SCOPED_WORKFLOW_DIRS) and are
 *     consumed, never re-ported.
 *   - Templates: `shared/actions/scoped_workflows.tmpl` (the whole body)
 *     rendered by `org/settings/actions.tmpl:9-11` into
 *     `.org-setting-content` (pageClass `organization settings actions`),
 *     `user/settings/actions.tmpl:9-11` into `.user-setting-content`
 *     (pageClass `user settings actions`) and `admin/actions.tmpl:9-11`
 *     into `.admin-setting-content` (pageClass `admin actions`).
 *   - Navbars: `user/settings/navbar.tmpl:55-56` (href
 *     `/user/settings/actions/scoped-workflows`), `org/settings/
 *     navbar.tmpl:44-45` (`{OrgLink}/settings/actions/scoped-workflows`),
 *     `admin/navbar.tmpl:84-85` (`/-/admin/actions/scoped-workflows`) — the
 *     Actions disclosure's open-arms include
 *     `.PageIsSharedSettingsScopedWorkflows` at all three.
 *   - Parse layer: `services/actions/scoped_workflow_cache.go:39-70`
 *     (LoadParsedScopedWorkflows — the default-branch HEAD parse),
 *     `modules/actions/scoped_workflows.go` (ListScopedWorkflows →
 *     listWorkflowsInDirs over ScopedWorkflowDirs; ParseScopedWorkflows —
 *     per entry the content read + `GetEventsFromContent` with the
 *     log-and-skip invalid arm; `WorkflowDisplayName`);
 *     `deriveScopedStatusContexts` re-parses per job (jobparser) × the
 *     status-producing events.
 *   - Store: `models/actions/scoped_workflow.go:18-41` (the
 *     `action_scoped_workflow_source` table — OwnerID 0 = instance-level,
 *     UNIQUE(owner_repo), WorkflowConfigs JSON) and :134-183 (the five ops
 *     the arms call: GetScopedWorkflowSourcesByOwner :135, GetScopedWorkflow
 *     Source :140, AddScopedWorkflowSource :153 — the exists no-op —,
 *     SetScopedWorkflowSourceConfigs :172, RemoveScopedWorkflowSource :180).
 *
 * ## THE STORE HANDOFF (the one missing substrate — the module does not fake it)
 *
 * The `action_scoped_workflow_source` table has NO landed D1 home (schema.ts
 * ends at the M3 wave's migrations; this unit's ownership excludes src/db/**)
 * and services/actions/** is import-only for this unit. Every arm
 * reads/writes the source rows, so the five ops ride the
 * `ScopedWorkflowSourcesStore` SEAM below — each method cites its upstream
 * function and ports its exact semantics (the exists no-op, the id-ordered
 * list, the configs-column replace). The D1 port (the schema columns +
 * the drizzle implementation) is the store HANDOFF; until it lands the
 * routes stay the documented honest 404s (the dead-link rule — the mount
 * recipe is the HANDOFF tail) and the nav sub-items stay the recorded dead
 * items (the settings-nav note).
 *
 * ## Documented reductions (§6 method — every one cites its upstream arm)
 *
 * - The parse cache (scoped_workflow_cache.go's LRU, 1024 SHA-keyed
 *   entries) reduces to a fresh parse per render: a page render parses at
 *   most a handful of sources once; Workers request statelessness makes the
 *   cache a service-layer concern for the store HANDOFF wave, not the
 *   page's.
 * - `deriveScopedStatusContexts`' per-job parse rides
 *   `splitWorkflowPayloads` (the M3-P per-job split — the `name:`-or-id
 *   jobName is jobparser's job.DisplayName twin). The matrix combo
 *   expansion and run-context name interpolation ride the E-tier YAML model
 *   port (STAGED): a matrix job previews ONCE under its authored name —
 *   upstream's own "appear as authored" note (:164) covers the expression
 *   arm, and a glob pattern still matches; the M3 E-tier rows retire this.
 * - `initSearchRepoBox` does not run (the family's inert-markup
 *   convention — the org general module's): the add input keeps upstream's
 *   name/placeholder/required contract as a plain text input;
 *   `data-global-init`/`data-uid`/`data-exclusive`/`data-full-name` stay as
 *   markup.
 * - `initScopedWorkflowRequired` (the bundle hook toggling the patterns
 *   textarea/context table on the required checkbox) does not run: the form
 *   posts the FULL row set regardless, and the server arm
 *   (applyScopedWorkflowRequiredForm) applies upstream's exact rules to
 *   whatever arrived — the no-JS post is byte-equivalent (the owner-general
 *   module's same reduction). The hidden-class initial state renders
 *   verbatim.
 * - The flashes (add_success / remove_success / update_success) ride the
 *   no-session-flash convention: the success arms answer the bare 303 onto
 *   the RedirectLink; the JSONError arms answer 400 with the locale text
 *   under context.go:276-278's shape (the repo-actions-view json-outcome
 *   convention).
 * - The store rows' SourceRepoID is this deployment's TEXT repositories.id
 *   (upstream int64 — the owner-actions-config store's id-space note); the
 *   `repo_id` form fields parse as strings (a junk id never matches a row —
 *   the FormInt64 junk-to-0 miss twin).
 * - The nav sub-item stays unrendered in the shared navbars (the recorded
 *   dead item — components/settings-nav.tsx and admin-users.tsx are shared
 *   files outside this unit's ownership): the frames take their nav element
 *   as a prop, and the HANDOFF tail carries the exact fold hunks for the
 *   mount window.
 */

import { Fragment, type Child } from "hono/jsx";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../../db/schema";
import { getRepositoryByName } from "../../services/actions/owner-actions-config";
import {
  applyScopedWorkflowRequiredForm,
  buildScopedWorkflowInfos,
  SCOPED_WORKFLOW_DIRS,
  scopedWorkflowStatusContextName,
  shouldEventCreateCommitStatus,
  type ScopedWorkflowConfig,
  type ScopedWorkflowInfo,
} from "../../services/actions/scoped-workflows";
import {
  getEventsFromContent,
  splitWorkflowPayloads,
  workflowDisplayName,
  WORKFLOW_FILE_MAX_BYTES,
  type WorkflowEvent,
} from "../../services/actions/trigger";
import { BaseLayout } from "../shell";
import type { UiContext } from "../ui-context";
import { OrgHeader } from "./org-home";
import type { OrgRecord } from "../../services/orgs/orgs";

// ---------------------------------------------------------------------------
// The locale (every string cites its upstream key — options/locale/
// locale_en-US.json at the pin)
// ---------------------------------------------------------------------------

export const scopedWorkflowsLocale = {
  scoped_workflows: "Scoped Workflows", // "actions.scoped_workflows" — the page Title (scoped_workflows.go:99) and the h4 header (tmpl:2)
  desc_org:
    "Register repositories as scoped-workflow sources. Workflow files under the scoped workflow directories of a source repository's default branch run on every repository of this organization, in that repository's own context.", // "actions.scoped_workflows.desc_org" (:114)
  desc_user:
    "Register repositories as scoped-workflow sources. Workflow files under the scoped workflow directories of a source repository's default branch run on every repository you own, in that repository's own context.", // "actions.scoped_workflows.desc_user" (:116)
  desc_global:
    "Register repositories as scoped-workflow sources. Workflow files under the scoped workflow directories of a source repository's default branch run on every repository on this instance, in that repository's own context. Because instance-level sources are evaluated on every repository's events, registering them can add overhead on large instances.", // "actions.scoped_workflows.desc_global" (:118)
  security_note:
    "A source repository's workflow content is executed in every repository it applies to, and its step scripts and their output are written to that repository's Actions logs and readable by anyone who can view the consuming repository's Actions. Registering a private repository as a source therefore discloses its workflow logic through those logs. Only register repositories whose workflow content may be shared with every consuming repository. If a scoped workflow references a reusable workflow from a private repository, make sure every consuming repository can read it, otherwise the workflow will fail there.", // "actions.scoped_workflows.security_note" (tmpl:7)
  source_add: "Add source repository", // "actions.scoped_workflows.source.add" (tmpl:14)
  search_repo_kind: "Search repos…", // "search.repo_kind" (the add input's placeholder, tmpl:11)
  remove: "Remove", // "remove" (the remove submit, tmpl:26)
  required_label:
    "Mark workflows as required (a required workflow cannot be disabled by repositories):", // "actions.scoped_workflows.required.label" (tmpl:32)
  workflow_file: "Workflow file", // "actions.runs.workflow_file" (tmpl:36)
  required: "Required", // "actions.workflow.required" (tmpl:37)
  patterns: "Required status check patterns", // "actions.scoped_workflows.required.patterns" (tmpl:38)
  patterns_note: "only enforced while the workflow is required", // "actions.scoped_workflows.required.patterns_note" (tmpl:38)
  missing_file: "file no longer in source", // "actions.scoped_workflows.required.missing_file" (tmpl:44)
  patterns_aria_prefix: "Required status check patterns for", // "actions.scoped_workflows.required.patterns_aria" — "Required status check patterns for %s" (tmpl:52; split for the aria label)
  patterns_hint:
    "Mark the workflow as required to configure its status check patterns.", // "actions.scoped_workflows.required.patterns_hint" (tmpl:53)
  expected_contexts:
    "Expected status checks (a check that matches a pattern is marked)", // "actions.scoped_workflows.required.expected_contexts" (tmpl:57)
  context_matched: "Matched", // "repo.settings.protect_status_check_matched" (tmpl:65)
  no_status_contexts:
    "This workflow posts no status checks, so marking it required would block every consuming pull request from merging. Uncheck Required.", // "actions.scoped_workflows.required.no_status_contexts" (tmpl:70)
  patterns_help:
    "One status check pattern (glob) per line. A consuming pull request can only be merged once a status matching every pattern has passed. This is enforced on any target branch that has a protection rule, even one with its own status checks disabled; a target branch with no protection rule is not gated.", // "actions.scoped_workflows.required.patterns_help" (tmpl:80)
  save: "Save", // "save" (the required form's submit, tmpl:81)
  no_files:
    "No scoped workflow files were found on the default branch.", // "actions.scoped_workflows.no_files" (tmpl:84)
  source_not_found: "Repository not found.", // "actions.scoped_workflows.source.not_found" — the JSONError body text (:261/:270/:297)
  patterns_empty:
    "Each required workflow needs at least one status check pattern.", // "actions.scoped_workflows.required.patterns_empty" — the SetRequired JSONError body (:334)
} as const;

/** The patterns textarea's aria label (tmpl:52's Tr with the entry name). */
export function scopedWorkflowsPatternsAria(entryName: string): string {
  return `${scopedWorkflowsLocale.patterns_aria_prefix} ${entryName}`;
}

// ---------------------------------------------------------------------------
// The scope (getScopedWorkflowsCtx, scoped_workflows.go:44-80)
// ---------------------------------------------------------------------------

/** The three scopes' shared shape — upstream's `scopedWorkflowsCtx` reduced
 *  to what the handlers read: the OwnerID (0 = instance-level), the
 *  RedirectLink the POST arms JSONRedirect onto, the search-box data and
 *  the desc string. */
export type ScopedWorkflowsScope =
  | { kind: "org"; ownerId: number; orgLink: string }
  | { kind: "user"; ownerId: number }
  | { kind: "admin" };

/** scopedWorkflowsCtx's derived fields (:50-76): the RedirectLink per scope
 *  (:54/:64/:74), SearchUID (:55/:65/:75 — 0 for the instance scope), the
 *  exclusive/full-name search flags (:144-145) and the desc (:112-119). */
export function scopedWorkflowsScopeContext(scope: ScopedWorkflowsScope): {
  ownerId: number;
  redirectLink: string;
  searchUid: number;
  searchExclusive: boolean;
  searchFullName: boolean;
  desc: string;
} {
  switch (scope.kind) {
    case "org":
      return {
        ownerId: scope.ownerId,
        redirectLink: `${scope.orgLink}/settings/actions/scoped-workflows`,
        searchUid: scope.ownerId,
        searchExclusive: true,
        searchFullName: false,
        desc: scopedWorkflowsLocale.desc_org,
      };
    case "user":
      return {
        ownerId: scope.ownerId,
        redirectLink: "/user/settings/actions/scoped-workflows",
        searchUid: scope.ownerId,
        searchExclusive: true,
        searchFullName: false,
        desc: scopedWorkflowsLocale.desc_user,
      };
    case "admin":
      return {
        ownerId: 0,
        redirectLink: "/-/admin/actions/scoped-workflows",
        searchUid: 0,
        searchExclusive: false,
        searchFullName: true,
        desc: scopedWorkflowsLocale.desc_global,
      };
  }
}

// ---------------------------------------------------------------------------
// The store seam (the HANDOFF — the five ops of models/actions/
// scoped_workflow.go:134-183 over the `action_scoped_workflow_source` table)
// ---------------------------------------------------------------------------

/** One source-registration row (the table's :19-32 shape; the WorkflowConfigs
 *  JSON already decoded — upstream's map[string]*ScopedWorkflowConfig where
 *  a nil config value never renders, the pure module's null skip). */
export interface ScopedWorkflowSourceRow {
  ownerId: number; // 0 = instance-level (the column's DEFAULT 0)
  sourceRepoId: string; // the TEXT repositories.id space (the header's note)
  workflowConfigs: Record<string, ScopedWorkflowConfig | null>;
}

/**
 * The five store ops the arms call, each citing its upstream function. The
 * D1 implementation (the schema columns + drizzle) is the store HANDOFF —
 * the mount window's unit lands it; the appliers below consume THIS seam so
 * they are store-agnostic and test-pinned against the semantics.
 */
export interface ScopedWorkflowSourcesStore {
  /** GetScopedWorkflowSourcesByOwner (:135-137) — the owner's sources
   *  ordered by id (FindScopedWorkflowSourceOpts.ToOrders "id", :56-58). */
  listSourcesByOwner(ownerId: number): Promise<ScopedWorkflowSourceRow[]>;
  /** GetScopedWorkflowSource (:140-150) — the (owner, repo) row or null
   *  (upstream's NotExist error, the JSONError arm's input). */
  getSource(ownerId: number, sourceRepoId: string): Promise<ScopedWorkflowSourceRow | null>;
  /** AddScopedWorkflowSource (:153-169) — insert unless already present
   *  (the exists pre-check AND the race re-check are the implementation's
   *  concern; the seam's contract is the no-op-on-duplicate outcome). */
  addSource(ownerId: number, sourceRepoId: string): Promise<void>;
  /** SetScopedWorkflowSourceConfigs (:172-177) — the workflow_configs
   *  column replace (Cols("workflow_configs") update by the owner+repo). */
  setSourceConfigs(ownerId: number, sourceRepoId: string, configs: Record<string, ScopedWorkflowConfig>): Promise<void>;
  /** RemoveScopedWorkflowSource (:180-183) — the delete; a missing row
   *  deletes zero rows silently (the handler has no not-found arm). */
  removeSource(ownerId: number, sourceRepoId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The parse assembly (LoadParsedScopedWorkflows + deriveScopedStatusContexts
// over the landed M3-P exports — the module header's reductions)
// ---------------------------------------------------------------------------

/** The engine read slice the parse consumes (trigger.ts's WorkflowTreeReads
 *  shape — structural, so the wiring's engineReads client fits). */
export interface ScopedWorkflowFileReads {
  listTree(ref: string, path: string): Promise<{ entries: Array<{ name: string; type: string }> } | null>;
  readBlob(ref: string, path: string): Promise<{ data: Uint8Array } | null>;
}

/** One parsed source workflow — upstream's `ParsedScopedWorkflow`
 *  (modules/actions/scoped_workflows.go:21-27) with the content as a string
 *  (the context derivation and the display name consume it decoded). */
export interface ScopedWorkflowSourceFile {
  entryName: string;
  displayName: string;
  content: string;
  events: WorkflowEvent[];
}

/**
 * `ListScopedWorkflows` + `ParseScopedWorkflows`
 * (modules/actions/scoped_workflows.go:17-19, 30-58) over the scoped dirs —
 * the runs-list module's listWorkflows twin (first-EXISTING-dir-wins,
 * :625-631; the recursive .yml/.yaml walk; the 1 MiB drop-not-truncate),
 * then per file the display name (`WorkflowDisplayName`) and the events
 * (`GetEventsFromContent`) with upstream's log-and-skip invalid arm
 * (:46-49 — an unparseable `on:` skips the entry, never fails the walk).
 * A read `null` (no dir / no blob through the null-on-failure client) skips
 * like upstream's miss arms.
 */
export async function parseScopedWorkflowFiles(reads: ScopedWorkflowFileReads, ref: string): Promise<ScopedWorkflowSourceFile[]> {
  let base: string | null = null;
  for (const dir of SCOPED_WORKFLOW_DIRS) {
    const tree = await reads.listTree(ref, dir);
    if (tree !== null) {
      base = dir;
      break;
    }
  }
  if (base === null) {
    return [];
  }
  const paths: string[] = [];
  const walk = async (prefix: string, depthBudget: number): Promise<void> => {
    if (depthBudget <= 0) return; // the pathological-nesting guard (the listWorkflows twin)
    const tree = await reads.listTree(ref, prefix);
    if (tree === null) return;
    for (const entry of tree.entries) {
      const path = `${prefix}/${entry.name}`;
      if (entry.type === "tree") {
        await walk(path, depthBudget - 1);
      } else if (path.endsWith(".yml") || path.endsWith(".yaml")) {
        paths.push(path);
      }
    }
  };
  await walk(base, 16);
  const out: ScopedWorkflowSourceFile[] = [];
  for (const entryName of paths) {
    const blob = await reads.readBlob(ref, entryName);
    if (blob === null) continue;
    // GetContentFromEntry's cap (the listWorkflows twin — an oversized file
    // is dropped, never truncated).
    if (blob.data.byteLength > WORKFLOW_FILE_MAX_BYTES) {
      continue;
    }
    const content = new TextDecoder().decode(blob.data);
    let events: WorkflowEvent[];
    try {
      events = getEventsFromContent(content);
    } catch (err) {
      // ParseScopedWorkflows' invalid arm (:46-49 — log.Warn + skip).
      console.error(`[actions-scoped-workflows] ignore invalid scoped workflow ${entryName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    out.push({ entryName, displayName: workflowDisplayName(entryName, content), content, events });
  }
  return out;
}

/**
 * `deriveScopedStatusContexts` (scoped_workflows.go:162-195): the
 * commit-status contexts a scoped workflow is expected to post on a
 * consumer — `scopedWorkflowStatusContextName(prefix, displayName, job,
 * event)` for each parsed job × each `on:` event whose runs post a status
 * (`shouldEventCreateCommitStatus` — workflow_dispatch/schedule post
 * none), deduped. The per-job parse rides `splitWorkflowPayloads` (the
 * M3-P split — the module header's matrix/expression reduction): a parse
 * failure answers NO contexts (upstream's jobparser.Parse error → nil,
 * :167-169), and the authored job name stands where the E-tier expansion
 * will later multiply it.
 */
export function deriveScopedStatusContexts(prefix: string, displayName: string, content: string, events: WorkflowEvent[]): string[] {
  let jobs: Array<{ name: string }>;
  try {
    jobs = splitWorkflowPayloads(content);
  } catch {
    return []; // the jobparser.Parse error arm (:167-169)
  }
  const eventNames = events.map((e) => e.name).filter(shouldEventCreateCommitStatus);
  const seen = new Set<string>();
  const contexts: string[] = [];
  for (const job of jobs) {
    for (const ev of eventNames) {
      const ctxName = scopedWorkflowStatusContextName(prefix, displayName, job.name, ev);
      if (seen.has(ctxName)) continue;
      seen.add(ctxName);
      contexts.push(ctxName);
    }
  }
  return contexts;
}

// ---------------------------------------------------------------------------
// The repo view + the D1 lookups (the arms' repositories reads)
// ---------------------------------------------------------------------------

/** The source repo as the page consumes it (upstream resolves
 *  `repo_model.Repository` rows; the render uses Link/FullName/ID and the
 *  parse uses IsEmpty/DefaultBranch/FullName). */
export interface ScopedWorkflowSourceRepoView {
  id: string;
  fullName: string; // ownerNamespace/slug
  link: string; // /{ownerNamespace}/{slug}
  defaultBranch: string;
  isEmpty: boolean;
}

/** The repositories-table read the GET assembly and the required arm ride
 *  (upstream GetRepositoryByID — models/repo; a null is the miss arm). */
export async function findScopedSourceRepoById(d1: D1Database, repoId: string): Promise<ScopedWorkflowSourceRepoView | null> {
  const row = await drizzle(d1)
    .select({
      id: repositories.id,
      ownerNamespace: repositories.ownerNamespace,
      slug: repositories.slug,
      defaultBranch: repositories.defaultBranch,
      isEmpty: repositories.isEmpty,
    })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .get();
  if (row === undefined) return null;
  return {
    id: row.id,
    fullName: `${row.ownerNamespace}/${row.slug}`,
    link: `/${row.ownerNamespace}/${row.slug}`,
    defaultBranch: row.defaultBranch,
    isEmpty: row.isEmpty,
  };
}

/**
 * `ScopedWorkflowAdd`'s GLOBAL-scope resolution (:257-264): the form value
 * cuts on the FIRST "/" (Go strings.Cut) into owner/name — no slash is the
 * not-found arm — then `GetRepositoryByOwnerAndName` (any repo on the
 * instance, the owner namespace case-folded like the owner-pinned lookup).
 */
export async function findRepoByOwnerAndName(d1: D1Database, ownerName: string, name: string): Promise<{ id: string } | null> {
  const row = await drizzle(d1)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, ownerName.toLowerCase()), eq(repositories.slug, name.toLowerCase())))
    .get();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The GET assembly (ScopedWorkflows, scoped_workflows.go:98-149)
// ---------------------------------------------------------------------------

/** One source's page view (:92-96's scopedWorkflowSourceView). */
export interface ScopedWorkflowSourceView {
  repo: ScopedWorkflowSourceRepoView;
  infos: ScopedWorkflowInfo[];
}

/** The page's render inputs: the scope-derived context + the sources'
 *  views + the joined dirs text (:147). */
export interface ScopedWorkflowsPageData {
  ownerId: number;
  redirectLink: string;
  searchUid: number;
  searchExclusive: boolean;
  searchFullName: boolean;
  desc: string;
  dirsText: string;
  sources: ScopedWorkflowSourceView[];
}

/**
 * `listSourceScopedWorkflowFiles` (scoped_workflows.go:197-243) assembled
 * over the parse seam: an EMPTY source parses nothing (the `repo.IsEmpty`
 * skip, :203 — the stored configs surface as orphans through the pure
 * merge), a parse-walk itself cannot fail here (the per-file arms skip),
 * and the parsed files map onto the pure module's input with the contexts
 * derived at `prefix = repo.fullName` (:212). The live+orphan merge and the
 * orphan sort are the landed `buildScopedWorkflowInfos`.
 */
export async function listSourceScopedWorkflowInfos(
  reads: ScopedWorkflowFileReads,
  repo: Pick<ScopedWorkflowSourceRepoView, "fullName" | "defaultBranch" | "isEmpty">,
  configs: Readonly<Record<string, ScopedWorkflowConfig | null>>,
): Promise<ScopedWorkflowInfo[]> {
  let parsed: ScopedWorkflowSourceFile[] = [];
  if (!repo.isEmpty) {
    parsed = await parseScopedWorkflowFiles(reads, repo.defaultBranch);
  }
  const withContexts = parsed.map((p) => ({
    entryName: p.entryName,
    displayName: p.displayName,
    contexts: deriveScopedStatusContexts(repo.fullName, p.displayName, p.content, p.events),
  }));
  return buildScopedWorkflowInfos(withContexts, configs);
}

/**
 * The GET arm's data assembly (ScopedWorkflows :98-149): the owner's
 * sources in id order (:121), each resolved onto its repo row — a MISSING
 * repo row logs and SKIPS the source (:129-133's continue, ported as the
 * null skip) — and the infos merged per source (:136). The scope-derived
 * fields ride scopedWorkflowsScopeContext.
 */
export async function loadScopedWorkflowsPageData(
  store: ScopedWorkflowSourcesStore,
  d1: D1Database,
  readsFor: (repo: ScopedWorkflowSourceRepoView) => ScopedWorkflowFileReads,
  scope: ScopedWorkflowsScope,
): Promise<ScopedWorkflowsPageData> {
  const ctx = scopedWorkflowsScopeContext(scope);
  const sources = await store.listSourcesByOwner(ctx.ownerId);
  const views: ScopedWorkflowSourceView[] = [];
  for (const src of sources) {
    const repo = await findScopedSourceRepoById(d1, src.sourceRepoId);
    if (repo === null) {
      // :129-133 — log.Error + continue: the page renders the surviving
      // sources rather than failing on a deleted one.
      console.error(`[actions-scoped-workflows] scoped workflows settings: load source repo ${src.sourceRepoId}: not found`);
      continue;
    }
    views.push({ repo, infos: await listSourceScopedWorkflowInfos(readsFor(repo), repo, src.workflowConfigs) });
  }
  return { ...ctx, dirsText: SCOPED_WORKFLOW_DIRS.join(", "), sources: views };
}

// ---------------------------------------------------------------------------
// The form parsers (the handlers' FormString/FormInt64/FormStrings reads)
// ---------------------------------------------------------------------------

/** ScopedWorkflowAdd's body (:255 — `repo_name`). */
export interface ScopedWorkflowAddForm {
  repoName: string;
}

export function parseScopedWorkflowAddForm(params: URLSearchParams): ScopedWorkflowAddForm {
  return { repoName: params.get("repo_name") ?? "" };
}

/** ScopedWorkflowSetRequired's body (:292-331): every workflow row submits
 *  its id in `workflow_ids` (repeated) and its patterns in
 *  `required_patterns[<id>]`; the checked rows' ids ride
 *  `required_workflow_ids` (repeated); `repo_id` pins the source. */
export interface ScopedWorkflowRequiredForm {
  repoId: string;
  workflowIds: string[];
  requiredWorkflowIds: string[];
  patternsByWorkflowId: Record<string, string>;
}

export function parseScopedWorkflowRequiredForm(params: URLSearchParams): ScopedWorkflowRequiredForm {
  const workflowIds = params.getAll("workflow_ids");
  const patternsByWorkflowId: Record<string, string> = {};
  for (const id of workflowIds) {
    patternsByWorkflowId[id] = params.get(`required_patterns[${id}]`) ?? "";
  }
  return {
    repoId: params.get("repo_id") ?? "",
    workflowIds,
    requiredWorkflowIds: params.getAll("required_workflow_ids"),
    patternsByWorkflowId,
  };
}

/** ScopedWorkflowRemove's body (:361 — `repo_id`). */
export interface ScopedWorkflowRemoveForm {
  repoId: string;
}

export function parseScopedWorkflowRemoveForm(params: URLSearchParams): ScopedWorkflowRemoveForm {
  return { repoId: params.get("repo_id") ?? "" };
}

// ---------------------------------------------------------------------------
// The POST arms (ScopedWorkflowAdd :245-280 / SetRequired :282-349 / Remove
// :351-368) — the outcomes map onto the wiring's responses (the header's
// flash reduction)
// ---------------------------------------------------------------------------

/** The JSONError body the not-found arms answer (:261/:270/:297) — the
 *  locale text under context.go:276-278's shape (the wiring answers 400). */
export const SCOPED_WORKFLOWS_SOURCE_NOT_FOUND_ERROR = { errorMessage: scopedWorkflowsLocale.source_not_found, renderFormat: "text" } as const;

/** The SetRequired patterns-empty refusal's body (:334) — same shape. */
export const SCOPED_WORKFLOWS_PATTERNS_EMPTY_ERROR = { errorMessage: scopedWorkflowsLocale.patterns_empty, renderFormat: "text" } as const;

export type ScopedWorkflowAddOutcome = { outcome: "added" } | { outcome: "source-not-found" };

/**
 * `ScopedWorkflowAdd` (:245-280): the GLOBAL scope cuts `repo_name` on the
 * first "/" and resolves any repo on the instance (:258-264 — no slash is
 * the not-found arm); the OWNER scopes resolve WITHIN the owner (:266-268 —
 * GetRepositoryByName, which also enforces the source is the owner's own).
 * A miss answers `source-not-found` (the JSONError); a hit registers
 * (AddScopedWorkflowSource's duplicate no-op) and answers `added` — the
 * wiring's 303 onto the RedirectLink with the flash reduced away.
 */
export async function applyScopedWorkflowAdd(
  store: ScopedWorkflowSourcesStore,
  d1: D1Database,
  scope: ScopedWorkflowsScope,
  form: ScopedWorkflowAddForm,
): Promise<ScopedWorkflowAddOutcome> {
  const ctx = scopedWorkflowsScopeContext(scope);
  let repoId: string | null;
  if (scope.kind === "admin") {
    const at = form.repoName.indexOf("/"); // Go strings.Cut on the first "/"
    if (at < 0) return { outcome: "source-not-found" };
    const found = await findRepoByOwnerAndName(d1, form.repoName.slice(0, at), form.repoName.slice(at + 1));
    repoId = found?.id ?? null;
  } else {
    const found = await getRepositoryByName(d1, ctx.ownerId, form.repoName);
    repoId = found?.id ?? null;
  }
  if (repoId === null) return { outcome: "source-not-found" };
  await store.addSource(ctx.ownerId, repoId);
  return { outcome: "added" };
}

export type ScopedWorkflowRequiredOutcome =
  | { outcome: "saved" }
  | { outcome: "source-not-found" }
  | { outcome: "patterns-empty" }
  | { outcome: "throw"; reason: string };

/**
 * `ScopedWorkflowSetRequired` (:282-349): the source must be registered
 * for this owner (:295-302 — the not-exist arm answers the JSONError), the
 * source repo must resolve (:305-309 — GetRepositoryByID's miss is a
 * ServerError → `throw`), the live entry-name set comes from the parse
 * (:310-320 — an empty source yields the empty set; a parse failure is a
 * ServerError → `throw`), and the config build is the landed
 * `applyScopedWorkflowRequiredForm` (the fail-fast patterns-empty refusal
 * included) persisted with SetScopedWorkflowSourceConfigs → `saved` (the
 * wiring's 303).
 */
export async function applyScopedWorkflowRequired(
  store: ScopedWorkflowSourcesStore,
  d1: D1Database,
  readsFor: (repo: ScopedWorkflowSourceRepoView) => ScopedWorkflowFileReads,
  scope: ScopedWorkflowsScope,
  form: ScopedWorkflowRequiredForm,
): Promise<ScopedWorkflowRequiredOutcome> {
  const ctx = scopedWorkflowsScopeContext(scope);
  const source = await store.getSource(ctx.ownerId, form.repoId);
  if (source === null) return { outcome: "source-not-found" }; // :296-297 — the ErrNotExist arm

  const repo = await findScopedSourceRepoById(d1, form.repoId);
  if (repo === null) {
    return { outcome: "throw", reason: `ScopedWorkflowSetRequired: GetRepositoryByID ${form.repoId} not found` }; // :305-309 — the ServerError class
  }
  const liveSet = new Set<string>();
  if (!repo.isEmpty) {
    let parsed: ScopedWorkflowSourceFile[];
    try {
      parsed = await parseScopedWorkflowFiles(readsFor(repo), repo.defaultBranch);
    } catch (err) {
      return { outcome: "throw", reason: `ScopedWorkflowSetRequired: LoadParsedScopedWorkflows: ${err instanceof Error ? err.message : String(err)}` };
    }
    for (const p of parsed) liveSet.add(p.entryName);
  }

  const applied = applyScopedWorkflowRequiredForm(form.workflowIds, form.requiredWorkflowIds, form.patternsByWorkflowId, liveSet);
  if (applied.outcome === "patterns-empty") return { outcome: "patterns-empty" }; // :333-336 — the fail-fast refusal
  await store.setSourceConfigs(ctx.ownerId, form.repoId, applied.configs);
  return { outcome: "saved" };
}

export type ScopedWorkflowRemoveOutcome = { outcome: "removed" };

/**
 * `ScopedWorkflowRemove` (:351-368): the delete by (owner, repo_id) —
 * upstream has NO not-found arm (RemoveScopedWorkflowSource deletes zero
 * rows silently) and answers success unconditionally → `removed` (the
 * wiring's 303).
 */
export async function applyScopedWorkflowRemove(store: ScopedWorkflowSourcesStore, scope: ScopedWorkflowsScope, form: ScopedWorkflowRemoveForm): Promise<ScopedWorkflowRemoveOutcome> {
  const ctx = scopedWorkflowsScopeContext(scope);
  await store.removeSource(ctx.ownerId, form.repoId);
  return { outcome: "removed" };
}

// ---------------------------------------------------------------------------
// The render — the SHARED body (shared/actions/scoped_workflows.tmpl) plus
// the three frames (org/user/admin actions switchyards). The navbars ride
// the `nav` prop (the header's nav reduction — the fold is the mount
// window's hunk).
// ---------------------------------------------------------------------------

/** The SHARED body (scoped_workflows.tmpl:1-88) — `link` is the page URL
 *  (upstream's `.Link`; the three forms post onto `link + "/add"`,
 *  `link + "/remove"`, `link + "/required"`). */
export function ScopedWorkflowsSections(props: { link: string; data: ScopedWorkflowsPageData }) {
  const locale = scopedWorkflowsLocale;
  const link = props.link;
  return (
    <>
      {/* tmpl:1-16 — the header segment: title, desc, the dirs help, the
          security note, the add-source form. */}
      <h4 class="ui top attached header">{locale.scoped_workflows}</h4>
      <div class="ui attached segment">
        <p>{props.data.desc}</p>
        {/* tmpl:6 — the %s is the dirs joined ", " (:147). The <code> span
            stays markup: the help renders the sentence with the dirs
            substituted inside it. */}
        <p>
          To provide scoped workflows from a repository, commit the workflow files under <code>{props.data.dirsText}</code> on its default
          branch, then register the repository as a source below.
        </p>
        <div class="ui warning message">{locale.security_note}</div>
        <form class="ui form form-fetch-action flex-text-block" method="post" action={`${link}/add`}>
          {/* tmpl:9-13 — the search box wrapper kept inert (the header's
              reduction): data-uid = RepoSearchUID, data-exclusive for the
              owner scopes, data-full-name for the instance scope. */}
          <div
            data-global-init="initSearchRepoBox"
            data-uid={String(props.data.searchUid)}
            data-exclusive={props.data.searchExclusive ? "true" : undefined}
            data-full-name={props.data.searchFullName ? "true" : undefined}
            class="ui search tw-flex-1"
          >
            <div class="ui input tw-w-full">
              <input class="prompt" name="repo_name" required placeholder={locale.search_repo_kind} autocomplete="off" />
            </div>
          </div>
          <button type="submit" class="ui primary button">
            {locale.source_add}
          </button>
        </form>
      </div>
      {/* tmpl:18-88 — the sources segment (only when sources exist). */}
      {props.data.sources.length > 0 ? (
        <div class="ui attached segment">
          {props.data.sources.map((src, i) => (
            <Fragment key={src.repo.id}>
              {i > 0 ? <div class="ui divider"></div> : null}
              <div class="flex-text-block tw-justify-between">
                <a class="tw-font-semibold gt-ellipsis tw-min-w-0" href={src.repo.link}>
                  {src.repo.fullName}
                </a>
                <form class="ui form form-fetch-action" method="post" action={`${link}/remove`}>
                  <input type="hidden" name="repo_id" value={src.repo.id} />
                  <button type="submit" class="ui red tiny button">
                    {locale.remove}
                  </button>
                </form>
              </div>
              {src.infos.length > 0 ? (
                <form class="ui form form-fetch-action tw-mt-3" method="post" action={`${link}/required`} data-global-init="initScopedWorkflowRequired">
                  <input type="hidden" name="repo_id" value={src.repo.id} />
                  <div class="text grey tw-mb-2">{locale.required_label}</div>
                  <table class="ui table tw-table-fixed">
                    <thead>
                      <tr>
                        <th class="tw-w-1/5">{locale.workflow_file}</th>
                        <th class="tw-w-24 tw-pr-4">{locale.required}</th>
                        <th>
                          {locale.patterns} <span class="tw-font-normal tw-text-text-light-2">({locale.patterns_note})</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {src.infos.map((info) => (
                        <tr>
                          <td>
                            {info.entryName}
                            {/* tmpl:44 — the space rides BEFORE the label
                                (between the entry name and the span). */}
                            {info.missing ? (
                              <>
                                {" "}
                                <span class="ui red mini label">{locale.missing_file}</span>
                              </>
                            ) : null}
                            <input type="hidden" name="workflow_ids" value={info.entryName} />
                          </td>
                          <td class="collapsing tw-pr-4">
                            <div class="ui checkbox">
                              <input
                                type="checkbox"
                                class="js-scoped-required-toggle"
                                name="required_workflow_ids"
                                value={info.entryName}
                                aria-label={info.entryName}
                                checked={info.required}
                              />
                              <label></label>
                            </div>
                          </td>
                          <td>
                            <textarea
                              class={`js-scoped-required-patterns${info.required ? "" : " tw-hidden"}`}
                              name={`required_patterns[${info.entryName}]`}
                              rows={2}
                              aria-label={scopedWorkflowsPatternsAria(info.entryName)}
                              data-default-pattern={`${src.repo.fullName}: ${info.displayName} / *`}
                              placeholder={`${src.repo.fullName}: ${info.displayName} / *`}
                            >
                              {info.patterns}
                            </textarea>
                            <span class={`js-scoped-required-hint text grey${info.required ? " tw-hidden" : ""}`}>{locale.patterns_hint}</span>
                            {info.contexts.length > 0 || !info.missing ? (
                              <table class={`ui celled table js-scoped-required-contexts tw-mt-2${info.required ? "" : " tw-hidden"}`}>
                                <thead>
                                  <tr>
                                    <th>{locale.expected_contexts}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {info.contexts.length > 0 ? (
                                    info.contexts.map((context) => (
                                      <tr>
                                        <td>
                                          <span class="js-scoped-context" data-context={context}>
                                            {context}
                                          </span>
                                          <span class="js-scoped-context-matched tw-font-semibold tw-italic tw-hidden">{locale.context_matched}</span>
                                        </td>
                                      </tr>
                                    ))
                                  ) : (
                                    <tr>
                                      <td class="tw-text-red">{locale.no_status_contexts}</td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div class="text grey tw-mb-2">{locale.patterns_help}</div>
                  <button type="submit" class="ui tiny primary button">
                    {locale.save}
                  </button>
                </form>
              ) : (
                <div class="text grey tw-mt-2">{locale.no_files}</div>
              )}
            </Fragment>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** The ORG frame (org/settings/actions.tmpl:1-13 — layout pageClass
 *  `organization settings actions`, the `.org-setting-content` wrapper
 *  around the shared body; the navbar rides the `nav` prop — the header's
 *  nav reduction). */
export function OrgScopedWorkflowsPage(props: { ctx: UiContext; data: ScopedWorkflowsPageData; org: OrgRecord; nav: Child }) {
  const orgLink = `/${props.org.username}`;
  const link = `${orgLink}/settings/actions/scoped-workflows`;
  return (
    <BaseLayout ctx={props.ctx} title={scopedWorkflowsLocale.scoped_workflows} pageClass="organization settings actions">
      <OrgHeader org={props.org} signedIn={props.ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        {props.nav}
        <div class="flex-container-main">
          <div class="org-setting-content">
            <ScopedWorkflowsSections link={link} data={props.data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The USER frame (user/settings/actions.tmpl:1-13 — layout pageClass
 *  `user settings actions`, the `.user-setting-content` wrapper; the navbar
 *  rides the `nav` prop). */
export function UserScopedWorkflowsPage(props: { ctx: UiContext; data: ScopedWorkflowsPageData; nav: Child }) {
  return (
    <BaseLayout ctx={props.ctx} title={scopedWorkflowsLocale.scoped_workflows} pageClass="user settings actions">
      <div class="ui container flex-container">
        {props.nav}
        <div class="flex-container-main">
          <div class="user-setting-content">
            <ScopedWorkflowsSections link="/user/settings/actions/scoped-workflows" data={props.data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The ADMIN frame (admin/actions.tmpl:1-16 — layout pageClass
 *  `admin actions`, the `.admin-setting-content` wrapper; the navbar rides
 *  the `nav` prop — AdminFamilyShell's structure minus its nav, whose union
 *  gains the tab at the fold window). */
export function AdminScopedWorkflowsPage(props: { ctx: UiContext; data: ScopedWorkflowsPageData; nav: Child }) {
  return (
    <BaseLayout ctx={props.ctx} title={scopedWorkflowsLocale.scoped_workflows} pageClass="admin actions">
      <div class="ui container fluid padded flex-container">
        {props.nav}
        <div class="flex-container-main">
          <div class="admin-setting-content">
            <ScopedWorkflowsSections link="/-/admin/actions/scoped-workflows" data={props.data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// THE HANDOFF (the store wave's unit lands the substrate + the mounts; the
// recipes below are the whole integration)
// ---------------------------------------------------------------------------
//
// 1. THE STORE (src/db + services/actions — this unit's forbidden files):
//    the `action_scoped_workflow_source` port — columns `id` (integer pk
//    autoincrement), `owner_id` (integer NOT NULL DEFAULT 0),
//    `source_repo_id` (text NOT NULL — the TEXT repositories.id space;
//    UNIQUE(owner_id, source_repo_id)), `workflow_configs` (text — the
//    ScopedWorkflowConfig-map JSON), `created_unix`/`updated_unix`
//    (scoped_workflow.go:19-32) — plus a drizzle implementation of
//    `ScopedWorkflowSourcesStore` with the exact semantics cited per method
//    (the id-ordered list, the duplicate no-op, the configs replace). A
//    services/actions/scoped-workflow-sources.ts home matches the family's
//    store layout.
//
// 2. THE NAV FOLD (components/settings-nav.tsx + pages/admin-users.tsx —
//    shared files this unit does not edit): add the
//    `actions-scoped-workflows` tab to UserSettingsNavTab + OrgSettings-
//    NavTab + AdminFamilyNavActive; render the sub-item in BOTH shared
//    navbars' Actions menus (user navbar.tmpl:55-56 href
//    `/user/settings/actions/scoped-workflows`; org navbar.tmpl:44-45 href
//    `${orgLink}/settings/actions/scoped-workflows`) and the admin family
//    nav's Actions group (admin/navbar.tmpl:84-85 href
//    `/-/admin/actions/scoped-workflows`); add the id to both open-arm
//    disjuncts (the :40/:29 or-arms' ScopedWorkflows disjunct).
//
// 3. THE MOUNTS (ui/index.ts — the parse arms + handlers; the routes stay
//    honest 404s until the store lands, so NONE of this registers before
//    the store wave):
//      user:   GET  /user/settings/actions/scoped-workflows
//              POST /user/settings/actions/scoped-workflows/{add,required,remove}
//              (the userSettingsTabPrologue gate — web.go:730's reqSignIn
//              group; MustEnableActions is compile-time true)
//      org:    GET  /:owner/settings/actions/scoped-workflows
//              POST /:owner/settings/actions/scoped-workflows/{add,required,remove}
//              (resolveOrgTeamsRequest's owner gate — web.go:1060's
//              settings subtree)
//      admin:  GET  /-/admin/actions/scoped-workflows
//              POST /-/admin/actions/scoped-workflows/{add,required,remove}
//              (adminPagePrologue — web.go:903; the POSTs
//              sameOriginGuard-first, the family convention)
//    Handler glue per scope (the org one shown; the others swap the
//    prologue + scope):
//
//      async function orgScopedWorkflowsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
//        const resolved = await resolveOrgTeamsRequest(c);
//        if (!resolved.ok) return resolved.response;
//        const { org, respond } = resolved;
//        if (resolved.route.family !== "org-actions-scoped-workflows") return respond(await c.notFound());
//        const data = await loadScopedWorkflowsPageData(scopedWorkflowSourcesStore(c.env.DB), c.env.DB,
//          (repo) => scopedWorkflowReads(c.env, repo), { kind: "org", ownerId: org.id, orgLink: `/${org.username}` });
//        return respond(c.html(renderScopedWorkflowsDocument(() => (
//          <OrgScopedWorkflowsPage ctx={resolved.ctx} data={data} org={org} nav={<OrgSettingsNavbar orgLink={`/${org.username}`} active="actions-scoped-workflows" />} />
//        )), 200));
//      }
//
//    The POST glue maps the outcomes: "added"/"saved"/"removed" → 303
//    Location: scopedWorkflowsScopeContext(scope).redirectLink;
//    "source-not-found" → 400 SCOPED_WORKFLOWS_SOURCE_NOT_FOUND_ERROR;
//    "patterns-empty" → 400 SCOPED_WORKFLOWS_PATTERNS_EMPTY_ERROR;
//    "throw" → the 500 shell (the ServerError class). `readsFor` maps the
//    engine client onto ScopedWorkflowFileReads (the repo-actions-workflow
//    module's WorkflowFileReads precedent): the default branch ref rides
//    repo.defaultBranch, listTree/readBlob delegate to engineReads.
//    parse arms: `tail.length === 2 && tail[0] === "actions" &&
//    tail[1] === "scoped-workflows"` (GET) + the three POST tails — chi's
//    static dispatch, no {id} combos to order around.
