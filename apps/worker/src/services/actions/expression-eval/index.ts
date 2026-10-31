// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The expression-eval barrel — SPEC-0012 §D5 tier E: actionslib v1.5.0's
// pkg/exprparser (interpreter/functions/json/object/memory) plus
// pkg/expreval's string-level Evaluator, with NO syntax layer (that is tier
// S, expression-syntax/) and NO call-site wiring (the E2-E5 rows stage the
// next wave).

export * from "./evaluator";
export * from "./functions";
export * from "./interpreter";
export * from "./json";
export * from "./kinds";
export * from "./memory";
export * from "./object";

import type { EvaluationEnvironment } from "./interpreter";
import {
  needsContext,
  newInterpeter,
  strategyContext,
  type Interpeter,
  type RunShape,
  type StrategyContextInput,
} from "./interpreter";

/**
 * ServerJobResult is the minimum a call site knows about one needed job —
 * upstream gitea's jobparser.JobResult (interpeter.go:48-53 of the
 * submodule's modules/actions/jobparser).
 */
export interface ServerJobResult {
  needs?: string[];
  result?: string;
  outputs?: Record<string, string>;
}

/**
 * ServerInterpeterInput is the §D2-pinned environment: github, needs,
 * strategy, matrix, vars, inputs only. The map slots the server deliberately
 * leaves nil (env/steps/runner/secrets) are absent — they read as upstream's
 * nil maps — and `job` is the empty JobContext upstream passes because Gitea
 * never re-checks an `if:` against a cancelled run (interpeter.go:39-41 of
 * the submodule's jobparser).
 */
export interface ServerInterpeterInput {
  jobId: string;
  /** strategy is the PARSED strategy — the model port owns the YAML parse. */
  strategy?: StrategyContextInput | undefined;
  matrix: Record<string, unknown> | undefined;
  /** gitContext is the github context value (upstream model.GithubContext's data). */
  gitContext: unknown;
  results: Record<string, ServerJobResult>;
  vars: Record<string, string> | undefined;
  inputs: Record<string, unknown> | undefined;
}

/**
 * newServerInterpeter is the server-side interpeter factory — upstream
 * gitea's jobparser.NewInterpeter (the submodule's interpeter.go:18-70):
 * Context "job", WorkingDir empty (hashFiles self-disables, §D1), the
 * contexts exactly as §D2 pins them.
 */
export function newServerInterpeter(input: ServerInterpeterInput): Interpeter {
  const run: RunShape = { jobId: input.jobId, workflow: { jobs: {} } };
  for (const [id, result] of Object.entries(input.results)) {
    run.workflow!.jobs[id] = { needs: result.needs, result: result.result, outputs: result.outputs };
  }

  const env: EvaluationEnvironment = {
    github: input.gitContext,
    // no need: env, steps, runner, secrets stay absent (nil maps upstream)
    job: {},
    strategy: strategyContext(input.strategy, 0, 0),
    matrix: input.matrix,
    needs: needsContext(run),
    inputs: input.inputs,
    vars: input.vars,
  };

  return newInterpeter(env, {
    run,
    workingDir: "", // hashFiles is not available outside steps
    context: "job",
  });
}
