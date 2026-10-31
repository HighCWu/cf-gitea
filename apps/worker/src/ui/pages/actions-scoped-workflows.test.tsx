/**
 * The SCOPED-WORKFLOWS settings surface's tests — the P1-3 staged pages'
 * shared core (pages/actions-scoped-workflows.tsx). The shell harness pins
 * the full-document DOM contract (shared/actions/scoped_workflows.tmpl +
 * the three switchyard frames at the pin, byte-level where upstream's own
 * quirks live — the space-before-missing-label, the hidden-class initial
 * state, the per-scope search-box flags) and the form parsers; the parse
 * assembly (parseScopedWorkflowFiles / deriveScopedStatusContexts /
 * listSourceScopedWorkflowInfos) pins the LoadParsedScopedWorkflows +
 * deriveScopedStatusContexts ports against in-memory trees; the POST
 * appliers pin ScopedWorkflowAdd/SetRequired/Remove's semantics over an
 * in-memory store fake + the REAL local D1 for the repo lookups (the org
 * general module's mixed harness).
 *
 * The route-level matrix (the prologue gates, the parse claims, the POST
 * registrations) lands WITH THE MOUNT — the routes stay the honest 404s
 * until the store HANDOFF lands (the core header); index.ts is a shared
 * file this suite does not edit.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import type { UiManifest } from "../manifest";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import {
  SCOPED_WORKFLOWS_PATTERNS_EMPTY_ERROR,
  SCOPED_WORKFLOWS_SOURCE_NOT_FOUND_ERROR,
  applyScopedWorkflowAdd,
  applyScopedWorkflowRemove,
  applyScopedWorkflowRequired,
  deriveScopedStatusContexts,
  findScopedSourceRepoById,
  listSourceScopedWorkflowInfos,
  loadScopedWorkflowsPageData,
  parseScopedWorkflowAddForm,
  parseScopedWorkflowRemoveForm,
  parseScopedWorkflowRequiredForm,
  parseScopedWorkflowFiles,
  scopedWorkflowsLocale,
  scopedWorkflowsPatternsAria,
  scopedWorkflowsScopeContext,
  type ScopedWorkflowSourceRow,
  type ScopedWorkflowSourcesStore,
  type ScopedWorkflowsPageData,
} from "./actions-scoped-workflows";
import { renderOrgScopedWorkflowsPage } from "./org-settings-actions-scoped-workflows";
import { renderUserScopedWorkflowsPage } from "./user-settings-actions-scoped-workflows";
import { renderAdminScopedWorkflowsPage } from "./admin-actions-scoped-workflows";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const ORG_ID = 7;
const USER_ID = 3;

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: USER_ID, username: "alice", isAdmin: true };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

/** The nav slot stand-in (the frames take their navbar element as a prop —
 *  the core header's nav reduction; the fold lands with the mount). */
const NAV_SLOT = <div class="flex-container-nav" data-test="nav-slot" />;

// --- the store fake ------------------------------------------------------------

/** The in-memory ScopedWorkflowSourcesStore — insertion order IS the id
 *  order twin (the list op orders by id). */
function memoryStore(initial: ScopedWorkflowSourceRow[] = []): ScopedWorkflowSourcesStore & { rows: ScopedWorkflowSourceRow[] } {
  const rows = initial.map((r) => ({ ...r, workflowConfigs: { ...r.workflowConfigs } }));
  const find = (ownerId: number, sourceRepoId: string): number => rows.findIndex((r) => r.ownerId === ownerId && r.sourceRepoId === sourceRepoId);
  return {
    rows,
    listSourcesByOwner: (ownerId) => Promise.resolve(rows.filter((r) => r.ownerId === ownerId)),
    getSource: (ownerId, sourceRepoId) => {
      const at = find(ownerId, sourceRepoId);
      const row = at >= 0 ? rows[at] : undefined;
      return Promise.resolve(row ?? null);
    },
    addSource: (ownerId, sourceRepoId) => {
      if (find(ownerId, sourceRepoId) >= 0) return Promise.resolve(); // the duplicate no-op (:153-169)
      rows.push({ ownerId, sourceRepoId, workflowConfigs: {} });
      return Promise.resolve();
    },
    setSourceConfigs: (ownerId, sourceRepoId, configs) => {
      const at = find(ownerId, sourceRepoId);
      const row = at >= 0 ? rows[at] : undefined;
      if (row !== undefined) row.workflowConfigs = { ...configs };
      return Promise.resolve();
    },
    removeSource: (ownerId, sourceRepoId) => {
      const at = find(ownerId, sourceRepoId);
      if (at >= 0) rows.splice(at, 1);
      return Promise.resolve();
    },
  };
}

// --- the reads fake --------------------------------------------------------------

/** An in-memory git tree: keys are full paths, values are file bytes. A
 *  directory "exists" (listTree non-null) when at least one file lives
 *  under it. */
function treeReads(files: Record<string, string>): {
  listTree(ref: string, path: string): Promise<{ entries: Array<{ name: string; type: string }> } | null>;
  readBlob(ref: string, path: string): Promise<{ data: Uint8Array } | null>;
} {
  const paths = Object.keys(files);
  return {
    listTree: (_ref: string, path: string) => {
      const clean = path.replace(/\/+$/, "");
      const prefix = clean === "" ? "" : `${clean}/`;
      const seen = new Set<string>();
      const entries: Array<{ name: string; type: string }> = [];
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        const head = slash >= 0 ? rest.slice(0, slash) : rest;
        if (head === "") continue;
        if (slash >= 0) {
          if (!seen.has(head)) {
            seen.add(head);
            entries.push({ name: head, type: "tree" });
          }
        } else {
          entries.push({ name: head, type: "blob" });
        }
      }
      return Promise.resolve(entries.length > 0 ? { entries } : null);
    },
    readBlob: (_ref: string, path: string) => {
      const content = files[path];
      return Promise.resolve(content === undefined ? null : { data: new TextEncoder().encode(content) });
    },
  };
}

const REF = "main";

const DEPLOY_WF = `name: Deploy
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo
`;

// --- the D1 harness ---------------------------------------------------------

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (7, 'coalition', 'coalition', 'The Coalition', 'org', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (2, 'otherowner', 'otherowner', 'Other Owner', 'user', unixepoch())",
  ).run();
  const insertRepo = "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES (?, ?, ?, ?, ?, 'main', 'public', ?, unixepoch())";
  await env.DB.prepare(insertRepo).bind("repo-1", "repo-1", "coalition", 7, "demo", 0).run();
  await env.DB.prepare(insertRepo).bind("repo-f", "repo-f", "otherowner", 2, "theirs", 0).run();
});

// --- the scope context (getScopedWorkflowsCtx, scoped_workflows.go:44-80) ----

describe("scopedWorkflowsScopeContext (getScopedWorkflowsCtx's three arms)", () => {
  it("derives the org scope — owner id, the OrgLink redirect, the exclusive owner-pinned search, desc_org", () => {
    expect(scopedWorkflowsScopeContext({ kind: "org", ownerId: ORG_ID, orgLink: "/coalition" })).toEqual({
      ownerId: ORG_ID,
      redirectLink: "/coalition/settings/actions/scoped-workflows", // :54
      searchUid: ORG_ID, // :55
      searchExclusive: true, // :144
      searchFullName: false, // :145
      desc: scopedWorkflowsLocale.desc_org, // :114
    });
  });
  it("derives the user scope — the doer's id, the AppSubURL-less literal, desc_user", () => {
    expect(scopedWorkflowsScopeContext({ kind: "user", ownerId: USER_ID })).toEqual({
      ownerId: USER_ID,
      redirectLink: "/user/settings/actions/scoped-workflows", // :64
      searchUid: USER_ID, // :65
      searchExclusive: true,
      searchFullName: false,
      desc: scopedWorkflowsLocale.desc_user, // :116
    });
  });
  it("derives the admin scope — owner 0, the full-name search, desc_global", () => {
    expect(scopedWorkflowsScopeContext({ kind: "admin" })).toEqual({
      ownerId: 0, // :71
      redirectLink: "/-/admin/actions/scoped-workflows", // :74
      searchUid: 0, // :75
      searchExclusive: false, // :144's !IsGlobal
      searchFullName: true, // :145
      desc: scopedWorkflowsLocale.desc_global, // :118
    });
  });
});

// --- the parse assembly ---------------------------------------------------------

describe("parseScopedWorkflowFiles (ListScopedWorkflows + ParseScopedWorkflows)", () => {
  it("walks the scoped dir recursively and parses names + events", async () => {
    const files = await parseScopedWorkflowFiles(
      treeReads({
        ".gitea/scoped_workflows/deploy.yml": DEPLOY_WF,
        ".gitea/scoped_workflows/nested/a.yml": "on: push\njobs:\n  x:\n    runs-on: x\n    steps:\n      - run: echo\n",
        ".gitea/workflows/not-scoped.yml": "on: push\njobs: {}\n", // the REPO dir — never walked
        "README.md": "x",
      }),
      REF,
    );
    expect(files.map((f) => f.entryName).sort()).toEqual([".gitea/scoped_workflows/deploy.yml", ".gitea/scoped_workflows/nested/a.yml"]);
    const deploy = files.find((f) => f.entryName === ".gitea/scoped_workflows/deploy.yml")!;
    expect(deploy.displayName).toBe("Deploy"); // WorkflowDisplayName's name: arm
    expect(deploy.events.map((e) => e.name)).toEqual(["push", "workflow_dispatch"]);
  });

  it("answers empty when no scoped dir exists — and drops an oversized file, never truncates", async () => {
    expect(await parseScopedWorkflowFiles(treeReads({ "README.md": "x" }), REF)).toEqual([]);
    const files = await parseScopedWorkflowFiles(
      treeReads({
        ".gitea/scoped_workflows/big.yml": `on: push\njobs: {}\n${"x".repeat(1024 * 1024 + 1)}`,
        ".gitea/scoped_workflows/ok.yml": "on: push\njobs: {}\n",
      }),
      REF,
    );
    expect(files.map((f) => f.entryName)).toEqual([".gitea/scoped_workflows/ok.yml"]); // the 1 MiB drop arm
  });

  it("skips a workflow whose YAML does not parse — the log-and-skip arm, the walk survives", async () => {
    const files = await parseScopedWorkflowFiles(
      treeReads({
        ".gitea/scoped_workflows/bad.yml": "on:\n\tpush: x\n", // the tab indentation — a YAML parse throw
        ".gitea/scoped_workflows/good.yml": "on: push\njobs: {}\n",
      }),
      REF,
    );
    expect(files.map((f) => f.entryName)).toEqual([".gitea/scoped_workflows/good.yml"]);
  });
});

describe("deriveScopedStatusContexts (scoped_workflows.go:162-195)", () => {
  it("builds the prefixed context per job x status-producing event, deduped", () => {
    const content = `name: Deploy
on: [push, pull_request, workflow_dispatch]
jobs:
  build:
    runs-on: x
    steps: [{ run: echo }]
  build2:
    name: build
    runs-on: x
    steps: [{ run: echo }]
`;
    const events = [
      { name: "push", acts: {}, schedules: null },
      { name: "workflow_dispatch", acts: {}, schedules: null },
    ];
    // workflow_dispatch posts no status (the allowlist) — push only; the
    // two jobs share the effective display name "build" → ONE deduped row.
    expect(deriveScopedStatusContexts("coalition/demo", "Deploy", content, events)).toEqual(["coalition/demo: Deploy / build (push)"]);
  });

  it("answers no contexts when the content does not parse — the jobparser error arm", () => {
    expect(deriveScopedStatusContexts("o/r", "D", ":::::", [{ name: "push", acts: {}, schedules: null }])).toEqual([]);
  });
});

describe("listSourceScopedWorkflowInfos (listSourceScopedWorkflowFiles over the pure merge)", () => {
  // The config keys are the ENTRY-NAME space the page itself renders and
  // posts back — the walk's path-spelled names (the landed trigger.ts
  // listWorkflows convention), so live rows merge and only true orphans
  // remain.
  const configs: Record<string, ScopedWorkflowSourceRow["workflowConfigs"][string]> = {
    ".gitea/scoped_workflows/deploy.yml": { required: true, patterns: ["coalition/demo: Deploy / build (push)"] },
    "gone.yml": { required: false, patterns: ["legacy"] },
    "required-gone.yml": { required: true, patterns: ["still-gates"] },
    "nullish.yml": null,
  };

  it("merges live rows with their stored configs and surfaces the orphans sorted", async () => {
    const infos = await listSourceScopedWorkflowInfos(
      treeReads({ ".gitea/scoped_workflows/deploy.yml": DEPLOY_WF }),
      { fullName: "coalition/demo", defaultBranch: REF, isEmpty: false },
      configs,
    );
    expect(infos).toEqual([
      {
        entryName: ".gitea/scoped_workflows/deploy.yml",
        displayName: "Deploy",
        required: true, // the stored config merged in (:214-217)
        patterns: "coalition/demo: Deploy / build (push)", // the newline-joined store
        contexts: ["coalition/demo: Deploy / build (push)"], // the derived preview
        missing: false,
      },
      // The orphans (configs without a parsed file), entry-sorted, a null
      // config never rendering (the pure module's skip).
      { entryName: "gone.yml", displayName: "gone.yml", required: false, patterns: "legacy", contexts: [], missing: true },
      { entryName: "required-gone.yml", displayName: "required-gone.yml", required: true, patterns: "still-gates", contexts: [], missing: true },
    ]);
  });

  it("answers the all-orphan view for an empty source — the repo.IsEmpty skip", async () => {
    const infos = await listSourceScopedWorkflowInfos(
      treeReads({}),
      { fullName: "coalition/demo", defaultBranch: REF, isEmpty: true },
      { "only.yml": { required: true, patterns: ["p"] } },
    );
    expect(infos).toEqual([{ entryName: "only.yml", displayName: "only.yml", required: true, patterns: "p", contexts: [], missing: true }]);
  });
});

// --- the GET assembly ------------------------------------------------------------

describe("loadScopedWorkflowsPageData (ScopedWorkflows, :98-149)", () => {
  it("assembles the views in id order, skipping a source whose repo row is gone", async () => {
    const store = memoryStore([
      { ownerId: ORG_ID, sourceRepoId: "repo-missing", workflowConfigs: {} },
      { ownerId: ORG_ID, sourceRepoId: "repo-1", workflowConfigs: { ".gitea/scoped_workflows/deploy.yml": { required: false, patterns: [] } } },
    ]);
    const data = await loadScopedWorkflowsPageData(store, env.DB, () => treeReads({ ".gitea/scoped_workflows/deploy.yml": DEPLOY_WF }), {
      kind: "org",
      ownerId: ORG_ID,
      orgLink: "/coalition",
    });
    expect(data.dirsText).toBe(".gitea/scoped_workflows"); // :147's joined dirs
    expect(data.sources).toHaveLength(1); // repo-missing skipped (the :129-133 continue)
    const view = data.sources[0];
    expect(view?.repo.fullName).toBe("coalition/demo");
    expect(view?.infos[0]?.entryName).toBe(".gitea/scoped_workflows/deploy.yml");
    expect(view?.infos[0]?.required).toBe(false); // the config merged by the entry name
    expect(data.redirectLink).toBe("/coalition/settings/actions/scoped-workflows");
  });
});

// --- the form parsers -------------------------------------------------------------

describe("the form parsers", () => {
  it("parses the add form — repo_name", () => {
    expect(parseScopedWorkflowAddForm(new URLSearchParams("repo_name=demo"))).toEqual({ repoName: "demo" });
    expect(parseScopedWorkflowAddForm(new URLSearchParams("")).repoName).toBe("");
  });

  it("parses the required form — the repeated ids, the bracketed per-row patterns", () => {
    const params = new URLSearchParams();
    params.append("repo_id", "repo-1");
    params.append("workflow_ids", "a.yml");
    params.append("workflow_ids", "b.yml");
    params.append("required_workflow_ids", "a.yml");
    params.set("required_patterns[a.yml]", "p1\np2");
    params.set("required_patterns[b.yml]", "");
    const form = parseScopedWorkflowRequiredForm(params);
    expect(form).toEqual({
      repoId: "repo-1",
      workflowIds: ["a.yml", "b.yml"],
      requiredWorkflowIds: ["a.yml"],
      patternsByWorkflowId: { "a.yml": "p1\np2", "b.yml": "" },
    });
    // patterns for an id NOT submitted in workflow_ids are ignored (the
    // per-workflow_ids loop is upstream's read shape, :330-331).
    params.set("required_patterns[ghost.yml]", "x");
    expect(parseScopedWorkflowRequiredForm(params).patternsByWorkflowId["ghost.yml"]).toBeUndefined();
  });

  it("parses the remove form — repo_id (junk stays a string, the TEXT id space)", () => {
    expect(parseScopedWorkflowRemoveForm(new URLSearchParams("repo_id=repo-1"))).toEqual({ repoId: "repo-1" });
    expect(parseScopedWorkflowRemoveForm(new URLSearchParams("repo_id=junk")).repoId).toBe("junk");
    expect(parseScopedWorkflowRemoveForm(new URLSearchParams("")).repoId).toBe("");
  });

  it("carries the JSONError bodies verbatim", () => {
    expect(SCOPED_WORKFLOWS_SOURCE_NOT_FOUND_ERROR).toEqual({ errorMessage: "Repository not found.", renderFormat: "text" });
    expect(SCOPED_WORKFLOWS_PATTERNS_EMPTY_ERROR).toEqual({
      errorMessage: "Each required workflow needs at least one status check pattern.",
      renderFormat: "text",
    });
  });
});

// --- the POST arms ------------------------------------------------------------------

describe("applyScopedWorkflowAdd (ScopedWorkflowAdd, :245-280)", () => {
  it("resolves the add WITHIN the owner at the org/user scopes — case-folded, foreign owners unknown", async () => {
    const store = memoryStore();
    expect(
      await applyScopedWorkflowAdd(store, env.DB, { kind: "org", ownerId: ORG_ID, orgLink: "/coalition" }, { repoName: "DEMO" }),
    ).toEqual({ outcome: "added" }); // lower_name case-fold
    expect(store.rows).toEqual([{ ownerId: ORG_ID, sourceRepoId: "repo-1", workflowConfigs: {} }]);
    // A duplicate add is the no-op (:153-169) — still "added", still one row.
    expect(await applyScopedWorkflowAdd(store, env.DB, { kind: "org", ownerId: ORG_ID, orgLink: "/coalition" }, { repoName: "demo" })).toEqual({
      outcome: "added",
    });
    expect(store.rows).toHaveLength(1);
    // Another owner's repo is unknown through this owner's lens
    // (GetRepositoryByName is owner-pinned, :266-268).
    expect(await applyScopedWorkflowAdd(store, env.DB, { kind: "user", ownerId: ORG_ID }, { repoName: "theirs" })).toEqual({
      outcome: "source-not-found",
    });
    expect(store.rows).toHaveLength(1);
  });

  it("cuts owner/name at the FIRST slash at the instance scope — no slash is the not-found arm", async () => {
    const store = memoryStore();
    expect(await applyScopedWorkflowAdd(store, env.DB, { kind: "admin" }, { repoName: "otherowner/theirs" })).toEqual({ outcome: "added" });
    expect(store.rows).toEqual([{ ownerId: 0, sourceRepoId: "repo-f", workflowConfigs: {} }]);
    expect(await applyScopedWorkflowAdd(store, env.DB, { kind: "admin" }, { repoName: "no-slash" })).toEqual({ outcome: "source-not-found" });
    expect(await applyScopedWorkflowAdd(store, env.DB, { kind: "admin" }, { repoName: "coalition/missing" })).toEqual({ outcome: "source-not-found" });
    expect(store.rows).toHaveLength(1);
  });
});

describe("applyScopedWorkflowRequired (ScopedWorkflowSetRequired, :282-349)", () => {
  const scope = { kind: "org", ownerId: ORG_ID, orgLink: "/coalition" } as const;

  it("refuses an unregistered source — the not-exist JSONError arm", async () => {
    const store = memoryStore();
    expect(
      await applyScopedWorkflowRequired(store, env.DB, () => treeReads({}), scope, {
        repoId: "repo-1",
        workflowIds: [],
        requiredWorkflowIds: [],
        patternsByWorkflowId: {},
      }),
    ).toEqual({ outcome: "source-not-found" });
  });

  it("answers the ServerError class when the source repo row is gone", async () => {
    const store = memoryStore([{ ownerId: ORG_ID, sourceRepoId: "repo-missing", workflowConfigs: {} }]);
    const outcome = await applyScopedWorkflowRequired(store, env.DB, () => treeReads({}), scope, {
      repoId: "repo-missing",
      workflowIds: [],
      requiredWorkflowIds: [],
      patternsByWorkflowId: {},
    });
    expect(outcome.outcome).toBe("throw"); // :305-309's GetRepositoryByID ServerError
  });

  it("builds the configs — required rows kept, live unchecked rows kept as history, unchecked orphans dropped", async () => {
    const store = memoryStore([{ ownerId: ORG_ID, sourceRepoId: "repo-1", workflowConfigs: {} }]);
    const reads = treeReads({
      ".gitea/scoped_workflows/a.yml": "on: push\njobs: {}\n",
      ".gitea/scoped_workflows/b.yml": "on: push\njobs: {}\n",
      // gone.yml is NOT on the default branch — the orphan
    });
    const outcome = await applyScopedWorkflowRequired(store, env.DB, () => reads, scope, {
      repoId: "repo-1",
      workflowIds: [".gitea/scoped_workflows/a.yml", ".gitea/scoped_workflows/b.yml", "gone.yml"],
      requiredWorkflowIds: [".gitea/scoped_workflows/a.yml"],
      patternsByWorkflowId: {
        ".gitea/scoped_workflows/a.yml": "p1\n\np2",
        ".gitea/scoped_workflows/b.yml": "history",
        "gone.yml": "dropped?",
      },
    });
    expect(outcome).toEqual({ outcome: "saved" });
    const savedRow = store.rows[0];
    expect(savedRow?.workflowConfigs).toEqual({
      ".gitea/scoped_workflows/a.yml": { required: true, patterns: ["p1", "p2"] }, // parsePatternLines' trim
      ".gitea/scoped_workflows/b.yml": { required: false, patterns: ["history"] }, // the live unchecked keep (:339)
      // gone.yml — the unchecked orphan DROPS (the only escapes are clearing
      // it here or removing the source, :224-226's comment).
    });
  });

  it("refuses the whole save when a required row carries no pattern — fail-fast, nothing stored", async () => {
    const store = memoryStore([{ ownerId: ORG_ID, sourceRepoId: "repo-1", workflowConfigs: { "old.yml": { required: true, patterns: ["keep"] } } }]);
    const outcome = await applyScopedWorkflowRequired(store, env.DB, () => treeReads({ ".gitea/scoped_workflows/a.yml": "on: push\njobs: {}\n" }), scope, {
      repoId: "repo-1",
      workflowIds: ["a.yml"],
      requiredWorkflowIds: ["a.yml"],
      patternsByWorkflowId: { "a.yml": "   " },
    });
    expect(outcome).toEqual({ outcome: "patterns-empty" }); // :333-336
    const untouched = store.rows[0];
    expect(untouched?.workflowConfigs).toEqual({ "old.yml": { required: true, patterns: ["keep"] } }); // untouched
  });

  it("treats an empty source as the empty live set — every stored config is an orphan here", async () => {
    const store = memoryStore([{ ownerId: ORG_ID, sourceRepoId: "repo-1", workflowConfigs: {} }]);
    await env.DB.prepare("UPDATE repositories SET is_empty = 1 WHERE id = 'repo-1'").run();
    const outcome = await applyScopedWorkflowRequired(store, env.DB, () => treeReads({}), scope, {
      repoId: "repo-1",
      workflowIds: [],
      requiredWorkflowIds: [],
      patternsByWorkflowId: {},
    });
    expect(outcome).toEqual({ outcome: "saved" }); // the :311-312 empty-set arm
    await env.DB.prepare("UPDATE repositories SET is_empty = 0 WHERE id = 'repo-1'").run();
  });
});

describe("applyScopedWorkflowRemove (ScopedWorkflowRemove, :351-368)", () => {
  it("removes the registration — and answers success for an absent row (no not-found arm)", async () => {
    const store = memoryStore([{ ownerId: ORG_ID, sourceRepoId: "repo-1", workflowConfigs: {} }]);
    expect(await applyScopedWorkflowRemove(store, { kind: "org", ownerId: ORG_ID, orgLink: "/coalition" }, { repoId: "repo-1" })).toEqual({
      outcome: "removed",
    });
    expect(store.rows).toEqual([]);
    expect(await applyScopedWorkflowRemove(store, { kind: "org", ownerId: ORG_ID, orgLink: "/coalition" }, { repoId: "repo-1" })).toEqual({
      outcome: "removed",
    }); // the silent zero-row delete twin
  });
});

// --- the repo lookup -------------------------------------------------------------

describe("findScopedSourceRepoById (GetRepositoryByID's twin)", () => {
  it("resolves the view fields — fullName/link/defaultBranch/isEmpty", async () => {
    expect(await findScopedSourceRepoById(env.DB, "repo-1")).toEqual({
      id: "repo-1",
      fullName: "coalition/demo",
      link: "/coalition/demo",
      defaultBranch: "main",
      isEmpty: false,
    });
    expect(await findScopedSourceRepoById(env.DB, "nope")).toBeNull();
  });
});

// --- the DOM (scoped_workflows.tmpl + the three switchyard frames) -----------------

/** A one-source page data fixture — live row + orphan, one required. */
const pageData: ScopedWorkflowsPageData = {
  ownerId: ORG_ID,
  redirectLink: "/coalition/settings/actions/scoped-workflows",
  searchUid: ORG_ID,
  searchExclusive: true,
  searchFullName: false,
  desc: scopedWorkflowsLocale.desc_org,
  dirsText: ".gitea/scoped_workflows",
  sources: [
    {
      repo: { id: "repo-1", fullName: "coalition/demo", link: "/coalition/demo", defaultBranch: "main", isEmpty: false },
      infos: [
        {
          entryName: "deploy.yml",
          displayName: "Deploy",
          required: true,
          patterns: "p1\np2",
          contexts: ["coalition/demo: Deploy / build (push)"],
          missing: false,
        },
        {
          entryName: "gone.yml",
          displayName: "gone.yml",
          required: false,
          patterns: "legacy",
          contexts: [],
          missing: true,
        },
        {
          entryName: "nostatus.yml",
          displayName: "No Status",
          required: true,
          patterns: "",
          contexts: [],
          missing: false,
        },
      ],
    },
  ],
};

const ORG_LINK = "/coalition";
const PAGE_LINK = `${ORG_LINK}/settings/actions/scoped-workflows`;

describe("ScopedWorkflowsSections (shared/actions/scoped_workflows.tmpl)", () => {
  const org = {
    id: ORG_ID,
    username: "coalition",
    usernameLower: "coalition",
    email: null,
    fullName: "The Coalition",
    description: null,
    website: null,
    location: null,
    avatarEmail: null,
    useCustomAvatar: false,
    visibility: "public" as const,
    numMembers: 2,
    repoAdminChangeTeamAccess: false,
    createdAt: new Date(1_700_000_000 * 1000),
  };

  it("renders the header segment — title, desc, the dirs help inside <code>, the security note, the add form", () => {
    const html = renderOrgScopedWorkflowsPage(ctx, pageData, org, NAV_SLOT);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Scoped Workflows - cf-gitea</title>");
    expect(html).toContain('aria-label="Scoped Workflows"');
    expect(html).toContain('<h4 class="ui top attached header">Scoped Workflows</h4>');
    // hono escapes the apostrophes (&#39;) — the escaped render of the
    // desc_org sentence.
    expect(html).toContain(
      `<p>${scopedWorkflowsLocale.desc_org.replaceAll("'", "&#39;")}</p>`,
    );
    // tmpl:6 — the %s (the dirs) substituted inside the locale sentence's
    // <code> span.
    expect(html).toContain(`<code>.gitea/scoped_workflows</code> on its default branch`);
    // The security note renders escaped (&#39; for the apostrophes).
    expect(html).toContain(`<div class="ui warning message">${scopedWorkflowsLocale.security_note.slice(0, 40).replaceAll("'", "&#39;")}`);
    // tmpl:8-15 — the add form posts onto Link/add; the search wrapper keeps
    // upstream's inert attrs (data-uid = SearchUID, data-exclusive at the
    // owner scopes).
    expect(html).toContain(`class="ui form form-fetch-action flex-text-block" method="post" action="${PAGE_LINK}/add"`);
    expect(html).toContain('data-global-init="initSearchRepoBox"');
    expect(html).toContain(`data-uid="${ORG_ID}"`);
    expect(html).toContain('data-exclusive="true"');
    expect(html).not.toContain('data-full-name="true"');
    expect(html).toContain('name="repo_name" required="" placeholder="Search repos…" autocomplete="off"');
    expect(html).toContain(`>${scopedWorkflowsLocale.source_add}</button>`);
  });

  it("renders the sources segment — the divider, the repo row, the remove form", () => {
    const html = renderOrgScopedWorkflowsPage(ctx, pageData, org, NAV_SLOT);
    expect(html).toContain('<div class="ui attached segment">');
    expect(html).toContain('<a class="tw-font-semibold gt-ellipsis tw-min-w-0" href="/coalition/demo">coalition/demo</a>');
    expect(html).toContain(`class="ui form form-fetch-action" method="post" action="${PAGE_LINK}/remove"`);
    expect(html).toContain('<input type="hidden" name="repo_id" value="repo-1"/>');
    expect(html).toContain(`>${scopedWorkflowsLocale.remove}</button>`);
  });

  it("renders the required form — the table contract with upstream's hidden-class initial state", () => {
    const html = renderOrgScopedWorkflowsPage(ctx, pageData, org, NAV_SLOT);
    expect(html).toContain(`class="ui form form-fetch-action tw-mt-3" method="post" action="${PAGE_LINK}/required" data-global-init="initScopedWorkflowRequired"`);
    expect(html).toContain(`<div class="text grey tw-mb-2">${scopedWorkflowsLocale.required_label}</div>`);
    expect(html).toContain('<th class="tw-w-1/5">Workflow file</th>');
    expect(html).toContain('<th class="tw-w-24 tw-pr-4">Required</th>');
    expect(html).toContain(`<th>Required status check patterns <span class="tw-font-normal tw-text-text-light-2">(${scopedWorkflowsLocale.patterns_note})</span></th>`);
    // The hidden workflow_ids input per row (tmpl:44).
    expect((html.match(/name="workflow_ids" value="[^"]+"/g) ?? []).length).toBe(3);
    // The required row's checkbox is checked; the orphan's is not.
    expect(html).toContain('class="js-scoped-required-toggle" name="required_workflow_ids" value="deploy.yml" aria-label="deploy.yml" checked');
    expect(html).toContain('name="required_workflow_ids" value="gone.yml" aria-label="gone.yml"/>');
    // The patterns textareas: name spelling, aria, the default-pattern
    // preview, the rows; hidden unless required (the JS hook's initial
    // state, rendered verbatim).
    expect(html).toContain('name="required_patterns[deploy.yml]" rows="2"');
    expect(html).toContain(`data-default-pattern="coalition/demo: Deploy / *" placeholder="coalition/demo: Deploy / *"`);
    expect(html).toContain(`class="js-scoped-required-patterns"`);
    expect(html).toContain(`class="js-scoped-required-patterns tw-hidden"`);
    expect(html).toContain(`aria-label="${scopedWorkflowsPatternsAria("deploy.yml")}"`);
    expect(html).toContain(">p1\np2</textarea>");
    // The hint span: hidden while required, visible otherwise.
    expect(html).toContain(`class="js-scoped-required-hint text grey tw-hidden"`);
    expect(html).toContain(`>${scopedWorkflowsLocale.patterns_hint}</span>`);
    // The contexts table: the live row previews the derived context; the
    // Matched twin span rides each row.
    expect(html).toContain('<span class="js-scoped-context" data-context="coalition/demo: Deploy / build (push)">');
    expect(html).toContain(`<span class="js-scoped-context-matched tw-font-semibold tw-italic tw-hidden">${scopedWorkflowsLocale.context_matched}</span>`);
    // A required workflow with NO contexts carries the red warning row
    // (tmpl:70) — blocking every consuming PR is the failure mode named.
    expect(html).toContain(`<td class="tw-text-red">${scopedWorkflowsLocale.no_status_contexts}</td>`);
    // The help + save (tmpl:80-81).
    expect(html).toContain(`<div class="text grey tw-mb-2">${scopedWorkflowsLocale.patterns_help}</div>`);
    expect(html).toContain(`>${scopedWorkflowsLocale.save}</button>`);
  });

  it("renders the missing-file label with the space BEFORE the span (tmpl:44's own spacing)", () => {
    const html = renderOrgScopedWorkflowsPage(ctx, pageData, org, NAV_SLOT);
    expect(html).toContain(`gone.yml <span class="ui red mini label">${scopedWorkflowsLocale.missing_file}</span>`);
  });

  it("renders the no-files note for a source whose parse found nothing (tmpl:84)", () => {
    const data: ScopedWorkflowsPageData = {
      ...pageData,
      sources: [{ repo: pageData.sources[0]!.repo, infos: [] }],
    };
    const html = renderOrgScopedWorkflowsPage(ctx, data, org, NAV_SLOT);
    expect(html).toContain(`<div class="text grey tw-mt-2">${scopedWorkflowsLocale.no_files}</div>`);
  });

  it("renders NO sources segment for a fresh scope (tmpl:18's if)", () => {
    const data: ScopedWorkflowsPageData = { ...pageData, sources: [] };
    const html = renderOrgScopedWorkflowsPage(ctx, data, org, NAV_SLOT);
    expect(html).toContain('data-global-init="initSearchRepoBox"'); // the header segment still renders
    expect(html).not.toContain(`action="${PAGE_LINK}/remove"`);
    expect(html).not.toContain(`action="${PAGE_LINK}/required"`);
  });
});

describe("the three frames (the switchyard layouts)", () => {
  const org = {
    id: ORG_ID,
    username: "coalition",
    usernameLower: "coalition",
    email: null,
    fullName: "The Coalition",
    description: null,
    website: null,
    location: null,
    avatarEmail: null,
    useCustomAvatar: false,
    visibility: "public" as const,
    numMembers: 2,
    repoAdminChangeTeamAccess: false,
    createdAt: new Date(1_700_000_000 * 1000),
  };

  it("org — pageClass `organization settings actions`, the org-setting-content wrapper, the nav slot in position", () => {
    const html = renderOrgScopedWorkflowsPage(ctx, pageData, org, NAV_SLOT);
    expect(html).toContain('class="page-content organization settings actions"');
    expect(html).toContain('<div class="org-setting-content">');
    expect(html).toContain('data-test="nav-slot"');
    expect(html).toContain(`action="${PAGE_LINK}/add"`); // the org Link shape
  });

  it("user — pageClass `user settings actions`, the user-setting-content wrapper, the /user Link shape", () => {
    const html = renderUserScopedWorkflowsPage(ctx, { ...pageData, desc: scopedWorkflowsLocale.desc_user }, NAV_SLOT);
    expect(html).toContain('class="page-content user settings actions"');
    expect(html).toContain('<div class="user-setting-content">');
    expect(html).toContain('data-test="nav-slot"');
    expect(html).toContain('action="/user/settings/actions/scoped-workflows/add"');
  });

  it("admin — pageClass `admin actions`, the admin-setting-content wrapper, the /-/admin Link shape and the full-name search flag", () => {
    const html = renderAdminScopedWorkflowsPage(
      ctx,
      { ...pageData, searchExclusive: false, searchFullName: true, desc: scopedWorkflowsLocale.desc_global },
      NAV_SLOT,
    );
    expect(html).toContain('class="page-content admin actions"');
    expect(html).toContain('<div class="admin-setting-content">');
    expect(html).toContain('data-test="nav-slot"');
    expect(html).toContain('action="/-/admin/actions/scoped-workflows/add"');
    expect(html).toContain('data-full-name="true"'); // :145 — the instance scope submits owner/name
    expect(html).not.toContain('data-exclusive="true"');
  });
});
