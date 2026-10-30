/**
 * The scoped-workflows substrate's pure-layer tests (services/actions/
 * scoped-workflows.ts — the v1.3.2 board's P1-3 / census C10 landing):
 * the path predicate over the scoped dirs, the status-context name
 * shapes, the status-producing event allowlist, the patterns-textarea
 * split, the settings page's view-model merge (live rows + sorted
 * orphans) and the SetRequired form's config semantics (the fail-fast
 * patterns-empty refusal, the kept-as-history live configs, the orphan
 * drops). Module-loader tests (the pre-mount house pattern) — pure, no
 * D1: every input is the store rows / parsed files the staged substrates
 * will supply.
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef:
 * modules/actions/workflows.go:53-70,156-179 + modules/setting/actions.go:
 * 41,53,147-158 + models/actions/scoped_workflow.go:34-38,100-106 +
 * routers/web/shared/actions/scoped_workflows.go:83-90,152-160,197-243,322-342
 * (the module header carries the full dependency map and the staged arms).
 */

import { describe, expect, it } from "vitest";

import {
  SCOPED_WORKFLOW_DIRS,
  applyScopedWorkflowRequiredForm,
  buildScopedWorkflowInfos,
  isScopedWorkflowPath,
  parsePatternLines,
  scopedStatusContextPrefix,
  scopedWorkflowStatusContextName,
  shouldEventCreateCommitStatus,
  workflowStatusContextName,
  type ScopedWorkflowConfig,
} from "./scoped-workflows";

describe("SCOPED_WORKFLOW_DIRS (setting/actions.go:53)", () => {
  it("defaults to .gitea/scoped_workflows only", () => {
    expect(SCOPED_WORKFLOW_DIRS).toEqual([".gitea/scoped_workflows"]);
  });
});

describe("isScopedWorkflowPath (workflows.go:62-70 — isWorkflowInDirs' scoped half)", () => {
  it("accepts .yml and .yaml directly under a scoped dir", () => {
    expect(isScopedWorkflowPath(".gitea/scoped_workflows/security.yml")).toBe(true);
    expect(isScopedWorkflowPath(".gitea/scoped_workflows/lint.yaml")).toBe(true);
  });

  it("rejects normal workflow paths, non-workflow files, and near-miss dirs", () => {
    // the repo-level workflow dir is NOT a scoped dir (actions.go:147-158's
    // overlap ban keeps the two disjoint)
    expect(isScopedWorkflowPath(".gitea/workflows/ci.yml")).toBe(false);
    expect(isScopedWorkflowPath(".gitea/scoped_workflows/readme.md")).toBe(false);
    expect(isScopedWorkflowPath(".gitea/scoped_workflows2/security.yml")).toBe(false);
    expect(isScopedWorkflowPath("security.yml")).toBe(false);
  });

  it("an empty configured dir list disables the feature (actions.go:147)", () => {
    expect(isScopedWorkflowPath(".gitea/scoped_workflows/security.yml", [])).toBe(false);
  });

  it("honors a configured extra dir (.github/scoped_workflows)", () => {
    const dirs = [".gitea/scoped_workflows", ".github/scoped_workflows"];
    expect(isScopedWorkflowPath(".github/scoped_workflows/lint.yaml", dirs)).toBe(true);
  });
});

describe("workflowStatusContextName (workflows.go:159-162)", () => {
  it("joins display / job (event)", () => {
    expect(workflowStatusContextName("Deploy", "build", "push")).toBe("Deploy / build (push)");
  });

  it("TrimSpace trims only the OUTER edges — padded fields keep their interior spaces", () => {
    expect(workflowStatusContextName(" Deploy ", " build ", "push")).toBe("Deploy  /  build  (push)");
  });
});

describe("scopedWorkflowStatusContextName (workflows.go:163-166)", () => {
  it("prefixes the source repo, set off by a colon", () => {
    expect(scopedWorkflowStatusContextName("alice/infra", "Deploy", "build", "push")).toBe(
      "alice/infra: Deploy / build (push)",
    );
  });

  it("trims the whole shape's outer edges (upstream's outer TrimSpace)", () => {
    expect(scopedWorkflowStatusContextName("alice/infra", " Deploy ", " build ", "push")).toBe(
      "alice/infra: Deploy  /  build  (push)",
    );
  });
});

describe("scopedStatusContextPrefix (models/actions/scoped_workflow.go:101-106)", () => {
  it("uses the source repo's full name when the row resolves", () => {
    expect(scopedStatusContextPrefix("alice/infra", 100)).toBe("alice/infra");
  });

  it("falls back to scoped:<id> when the source repo row is gone", () => {
    expect(scopedStatusContextPrefix(null, 100)).toBe("scoped:100");
  });
});

describe("shouldEventCreateCommitStatus (workflows.go:168-179)", () => {
  it("admits exactly the six status-producing events", () => {
    for (const event of ["push", "pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment", "release"]) {
      expect(shouldEventCreateCommitStatus(event)).toBe(true);
    }
  });

  it("rejects the non-status events (the contexts derivation filters on this)", () => {
    for (const event of ["workflow_dispatch", "schedule", "workflow_call", "repository_dispatch", ""]) {
      expect(shouldEventCreateCommitStatus(event)).toBe(false);
    }
  });
});

describe("parsePatternLines (scoped_workflows.go:152-160)", () => {
  it("splits on newlines, trims each line, drops empties", () => {
    expect(parsePatternLines("alice/infra: Deploy / * \n\n  alice/infra: Deploy / build (push)  \n\n")).toEqual([
      "alice/infra: Deploy / *",
      "alice/infra: Deploy / build (push)",
    ]);
  });

  it("a blank textarea yields no patterns", () => {
    expect(parsePatternLines("")).toEqual([]);
    expect(parsePatternLines("\n  \n")).toEqual([]);
  });
});

describe("buildScopedWorkflowInfos (scoped_workflows.go:197-243)", () => {
  const configs: Record<string, ScopedWorkflowConfig | null> = {
    "security.yml": { required: true, patterns: ["alice/infra: Security / *"] },
    "lint.yml": { required: false, patterns: ["alice/infra: Lint / *"] },
    "gone.yml": { required: true, patterns: ["alice/infra: Gone / *"] },
    "dropped-null.yml": null,
  };

  it("merges the stored config into the live rows and surfaces orphans sorted by entry name", () => {
    const infos = buildScopedWorkflowInfos(
      [
        { entryName: "lint.yml", displayName: "Lint", contexts: ["alice/infra: Lint / build (push)"] },
        { entryName: "security.yml", displayName: "Security", contexts: ["alice/infra: Security / scan (push)"] },
      ],
      configs,
    );
    // live rows first, in parse order, with the config merged in
    expect(infos[0]).toEqual({
      entryName: "lint.yml",
      displayName: "Lint",
      required: false,
      patterns: "alice/infra: Lint / *",
      contexts: ["alice/infra: Lint / build (push)"],
      missing: false,
    });
    expect(infos[1]).toEqual({
      entryName: "security.yml",
      displayName: "Security",
      required: true,
      patterns: "alice/infra: Security / *",
      contexts: ["alice/infra: Security / scan (push)"],
      missing: false,
    });
    // the orphan: sorted AFTER the live rows (only one here), display name
    // degrading to the entry name, patterns preserved, contexts empty
    expect(infos[2]).toEqual({
      entryName: "gone.yml",
      displayName: "gone.yml",
      required: true,
      patterns: "alice/infra: Gone / *",
      contexts: [],
      missing: true,
    });
    expect(infos).toHaveLength(3); // the null config never renders
  });

  it("orphans sort by entry name across the map's iteration order", () => {
    const infos = buildScopedWorkflowInfos([], {
      "zeta.yml": { required: false, patterns: ["p"] },
      "alpha.yml": { required: true, patterns: ["q"] },
      "mid.yml": null,
    });
    expect(infos.map((i) => i.entryName)).toEqual(["alpha.yml", "zeta.yml"]);
    expect(infos.every((i) => i.missing)).toBe(true);
  });

  it("an empty parse (empty source or the parse-error fall-through) renders configs as orphans only", () => {
    const infos = buildScopedWorkflowInfos([], { "security.yml": { required: true, patterns: ["p"] } });
    expect(infos).toEqual([
      { entryName: "security.yml", displayName: "security.yml", required: true, patterns: "p", contexts: [], missing: true },
    ]);
  });

  it("a live workflow without a stored config renders required=false with empty patterns", () => {
    const infos = buildScopedWorkflowInfos([{ entryName: "new.yml", displayName: "New", contexts: [] }], {});
    expect(infos[0]).toEqual({
      entryName: "new.yml",
      displayName: "New",
      required: false,
      patterns: "",
      contexts: [],
      missing: false,
    });
  });
});

describe("applyScopedWorkflowRequiredForm (scoped_workflows.go:322-342)", () => {
  const live = new Set(["security.yml", "lint.yml", "unchecked.yml"]);

  it("refuses the whole save when a checked row has no pattern (fail-fast, :333-336)", () => {
    expect(
      applyScopedWorkflowRequiredForm(
        ["security.yml", "lint.yml"],
        ["security.yml", "lint.yml"],
        { "security.yml": "alice/infra: Security / *", "lint.yml": "\n  \n" },
        live,
      ),
    ).toEqual({ outcome: "patterns-empty" });
  });

  it("keeps required rows and live unchecked rows with patterns (as history, :339)", () => {
    const result = applyScopedWorkflowRequiredForm(
      ["security.yml", "lint.yml", "unchecked.yml"],
      ["security.yml"],
      {
        "security.yml": "alice/infra: Security / *",
        "lint.yml": "alice/infra: Lint / *",
        "unchecked.yml": "",
      },
      live,
    );
    expect(result).toEqual({
      outcome: "saved",
      configs: {
        "security.yml": { required: true, patterns: ["alice/infra: Security / *"] },
        "lint.yml": { required: false, patterns: ["alice/infra: Lint / *"] },
        // an unchecked LIVE row with NO patterns drops its config (the
        // no-op-edit clear arm)
      },
    });
  });

  it("drops an unchecked ORPHAN even when patterns were submitted (:339's liveSet arm)", () => {
    const result = applyScopedWorkflowRequiredForm(
      ["security.yml", "gone.yml"],
      [],
      { "security.yml": "p1", "gone.yml": "p2" },
      live,
    );
    expect(result).toEqual({ outcome: "saved", configs: { "security.yml": { required: false, patterns: ["p1"] } } });
  });

  it("keeps a REQUIRED orphan (a required orphan still gates merges, :224-226)", () => {
    const result = applyScopedWorkflowRequiredForm(["gone.yml"], ["gone.yml"], { "gone.yml": "p" }, new Set());
    expect(result).toEqual({ outcome: "saved", configs: { "gone.yml": { required: true, patterns: ["p"] } } });
  });

  it("a row absent from workflow_ids never enters the config map, whatever its patterns field carries", () => {
    const result = applyScopedWorkflowRequiredForm(["security.yml"], [], { "ghost.yml": "p" }, live);
    expect(result).toEqual({ outcome: "saved", configs: {} });
  });
});
