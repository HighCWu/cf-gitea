// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The static-validation scan's pin tests — SPEC-0012 §D2 #9. The
// allowed/rejected lists are SERVER-PINNED, not invented: job `if:` gets
// exactly validate.go:19-20's ["github","gitea","needs","vars","inputs"]
// ("which github.com decides before the matrix, so without the matrix and
// strategy contexts") and run-name gets validate.go:48's
// ["github","gitea","inputs","vars"]; every other named context is rejected
// server-side because the server's own environment leaves it nil
// (actionslib:pkg/exprparser/interpreter.go:43,47-50, SPEC-0012 §D1). The
// error texts are validate.go:50/:60 verbatim.

import { describe, expect, it } from "vitest";

import { jobConditionContexts, runNameContexts, unavailableContext, validateStaticExpressions } from "./static-validation";

describe("unavailableContext (validate.go:66-74)", () => {
  it("passes the allowed contexts, case-insensitively", () => {
    expect(unavailableContext("${{ github.event_name == 'push' }}", jobConditionContexts)).toBe("");
    expect(unavailableContext("${{ GITHUB.event_name }}", jobConditionContexts)).toBe("");
    expect(unavailableContext("${{ needs.build.result }}", jobConditionContexts)).toBe("");
    expect(unavailableContext("${{ gitea.context }}", jobConditionContexts)).toBe("");
    expect(unavailableContext("${{ vars.X }}", jobConditionContexts)).toBe("");
    expect(unavailableContext("${{ inputs.X }}", jobConditionContexts)).toBe("");
    expect(unavailableContext("github.event_name == 'push'", jobConditionContexts)).toBe("");
    expect(unavailableContext("", jobConditionContexts)).toBe("");
  });

  it("rejects the contexts the server never populates", () => {
    // interpreter.go:43,47-50 — env/job/steps/runner/secrets are nil server-side.
    expect(unavailableContext("${{ env.X }}", jobConditionContexts)).toBe("env");
    expect(unavailableContext("${{ steps.build.outputs.x }}", jobConditionContexts)).toBe("steps");
    expect(unavailableContext("${{ secrets.TOKEN }}", jobConditionContexts)).toBe("secrets");
    expect(unavailableContext("${{ job.status }}", jobConditionContexts)).toBe("job");
    expect(unavailableContext("${{ runner.os }}", jobConditionContexts)).toBe("runner");
    // validate.go:19-20's comment — matrix and strategy are absent job-level.
    expect(unavailableContext("${{ matrix.os }}", jobConditionContexts)).toBe("matrix");
    expect(unavailableContext("${{ strategy.fail-fast }}", jobConditionContexts)).toBe("strategy");
    expect(unavailableContext("${{ jobs.build.result }}", jobConditionContexts)).toBe("jobs");
  });

  it("is case-insensitive on the rejection too", () => {
    expect(unavailableContext("${{ MATRIX.os }}", jobConditionContexts)).toBe("MATRIX");
    expect(unavailableContext("${{ Env.X }}", jobConditionContexts)).toBe("Env");
  });

  it("defers an unparseable value (Match's parse-error arm, subexpr.go:56-62)", () => {
    // A value that does not parse counts as no scan hit here; the error is
    // the workflow's parse error, reported upstream at insert.
    expect(unavailableContext("${{ env.X", jobConditionContexts)).toBe("");
  });

  it("finds the context anywhere in the tree", () => {
    expect(unavailableContext("needs.a.outputs.x == 'y' && ${{ secrets.S }}", jobConditionContexts)).toBe("secrets");
    expect(unavailableContext("${{ contains(fromJSON('[]'), matrix.os) }}", jobConditionContexts)).toBe("matrix");
  });
});

describe("validateStaticExpressions (validate.go:47-62)", () => {
  it("passes a plain push workflow's conditions", () => {
    expect(
      validateStaticExpressions({
        runName: "${{ github.event.head_commit.message }}",
        jobIfs: { build: "github.event_name == 'push'" },
      }),
    ).toBeNull();
  });

  it("reports the job-if offender with upstream's message", () => {
    expect(
      validateStaticExpressions({ jobIfs: { build: "${{ matrix.os == 'ubuntu' }}" } }),
    ).toBe("job build: Unrecognized named-value: 'matrix'"); // validate.go:60
  });

  it("reports the run-name offender with upstream's message", () => {
    expect(validateStaticExpressions({ runName: "deploy ${{ needs.build.outputs.x }}" })).toBe(
      "run-name: Unrecognized named-value: 'needs'", // validate.go:50 — needs is NOT in the run-name list
    );
  });

  it("scans job conditions before the run name", () => {
    expect(
      validateStaticExpressions({
        runName: "${{ env.BAD }}",
        jobIfs: { build: "${{ env.WORSE }}" },
      }),
    ).toBe("job build: Unrecognized named-value: 'env'");
  });

  it("accepts every run-name context and rejects the rest", () => {
    expect(unavailableContext("${{ github.ref }}", runNameContexts)).toBe("");
    expect(unavailableContext("${{ inputs.name }}", runNameContexts)).toBe("");
    expect(unavailableContext("${{ vars.X }}", runNameContexts)).toBe("");
    expect(unavailableContext("${{ needs.x }}", runNameContexts)).toBe("needs");
    expect(unavailableContext("${{ matrix.x }}", runNameContexts)).toBe("matrix");
  });
});
