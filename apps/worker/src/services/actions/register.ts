/**
 * The runner registration surface (SPEC-0012 §2.2, M1a): the
 * Register/Declare handler logic ported from
 * routers/api/actions/runner/runner.go:44-165, plus the registration-token
 * lifecycle (the runner_token.go service re-exported from model.ts).
 *
 * THE REGISTRATION-TOKEN POSTURE (the SPEC's draft-correction NOTE): a
 * registration token is REUSABLE UNTIL RESET — `NewRunnerTokenWithValue`
 * deactivates all same-scope tokens before inserting the new active one, so
 * "reset" = create-new-and-deactivate-old and one active token registers a
 * whole fleet. The upstream handler's post-success
 * `runnerToken.IsActive = true` write (runner.go:96-98, unchanged since
 * 4011821c94) is a vestigial no-op at this pin and is deliberately NOT
 * ported.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunners, repositories, users } from "../../db/schema";
import {
  createRunner,
  cryptoRandomToken,
  cryptoRandomSalt,
  ellipsisDisplayString,
  getRunnerTokenByValue,
  hashRunnerToken,
  updateRunner,
  type RunnerRow,
} from "./model";

export {
  getLatestRunnerToken,
  getOrCreateActiveRunnerToken,
  getRunnerTokenByValue,
  newRunnerToken,
  newRunnerTokenWithValue,
} from "./model";

/** runnerCapabilityCancelling (runner.go:70-72) — the wire string a runner
 *  advertises to signal the transitional cancelling flow. */
export const RUNNER_CAPABILITY_CANCELLING = "cancelling";

/**
 * RunnerCapabilities (models/actions/run_job_summary.go:30-34) — the
 * server-side capability list advertised on every Declare response via the
 * `X-Gitea-Actions-Capabilities` header ("to avoid a hard dependency on a
 * proto bump", runner.go:151-154). Today: job-summary (M1b serves it).
 */
export const RUNNER_CAPABILITIES = "job-summary";

export const X_GITEA_ACTIONS_CAPABILITIES_HEADER = "X-Gitea-Actions-Capabilities";

export interface RegisterInput {
  name: string;
  token: string;
  version: string;
  labels: string[];
  ephemeral: boolean;
  capabilities: string[];
}

export type RegisterOutcome =
  | { kind: "ok"; runner: RunnerRow & { token: string } }
  | { kind: "error"; message: string };

/**
 * Register (runner.go:44-114). Plain-error outcomes carry upstream's exact
 * messages — the connect layer maps them to CodeUnknown with the message
 * (withErrorMessages, interceptor.go:36-44).
 */
export async function registerRunner(d1: D1Database, input: RegisterInput): Promise<RegisterOutcome> {
  if (input.token === "" || input.name === "") {
    return { kind: "error", message: "missing runner token, name" };
  }

  const runnerToken = await getRunnerTokenByValue(d1, input.token);
  if (runnerToken === null) {
    return { kind: "error", message: "runner registration token not found" };
  }
  if (!runnerToken.isActive) {
    return {
      kind: "error",
      message: "runner registration token has been invalidated, please use the latest one",
    };
  }

  const db = drizzle(d1);
  if (runnerToken.ownerId > 0) {
    const owner = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, runnerToken.ownerId))
      .limit(1);
    if (owner.length === 0) {
      return { kind: "error", message: "owner of the token not found" };
    }
  }
  if (runnerToken.repoId !== "") {
    const repo = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.id, runnerToken.repoId))
      .limit(1);
    if (repo.length === 0) {
      return { kind: "error", message: "repository of the token not found" };
    }
  }

  const labels = input.labels;
  const hasCancellingSupport = input.capabilities.includes(RUNNER_CAPABILITY_CANCELLING);

  const runner = await createRunner(d1, {
    uuid: crypto.randomUUID(),
    // util.EllipsisDisplayString(req.Name, 255) (runner.go:75).
    name: ellipsisDisplayString(input.name, 255),
    ownerId: runnerToken.ownerId,
    repoId: runnerToken.repoId,
    version: input.version,
    agentLabels: labels,
    ephemeral: input.ephemeral,
    hasCancellingSupport,
  });

  // Upstream's vestigial `runnerToken.IsActive = true` write is NOT ported —
  // at this pin the token is already active (see the module header).

  return { kind: "ok", runner };
}

export interface DeclareInput {
  version: string;
  labels: string[];
  capabilities: string[];
}

/**
 * applyDeclareRequestToRunner (runner.go:120-140): update agent_labels +
 * version always; has_cancelling_support only when it flips. Returns the
 * columns actually written (the upstream UpdateRunner cols spelling).
 */
export function declareChanges(
  runner: RunnerRow,
  input: DeclareInput,
): {
  cols: Partial<Pick<RunnerRow, "agentLabels" | "version" | "hasCancellingSupport">>;
  hasCancellingSupport: boolean;
} {
  const hasCancellingSupport = input.capabilities.includes(RUNNER_CAPABILITY_CANCELLING);
  const cols: Partial<Pick<RunnerRow, "agentLabels" | "version" | "hasCancellingSupport">> = {
    agentLabels: JSON.stringify(input.labels),
    version: input.version,
  };
  if (runner.hasCancellingSupport !== hasCancellingSupport) {
    cols.hasCancellingSupport = hasCancellingSupport;
  }
  return { cols, hasCancellingSupport };
}

/** Declare (runner.go:142-165) — persists and returns the updated runner. */
export async function declareRunner(
  d1: D1Database,
  runner: RunnerRow,
  input: DeclareInput,
): Promise<RunnerRow> {
  const { cols } = declareChanges(runner, input);
  await updateRunner(d1, runner.id, cols);
  // Re-read so the response reflects the persisted row (upstream updates its
  // in-memory struct; same observable values).
  const rows = await drizzle(d1)
    .select()
    .from(actionRunners)
    .where(eq(actionRunners.id, runner.id))
    .limit(1);
  const updated = rows[0];
  if (updated === undefined) {
    throw new Error("actions: runner vanished during declare");
  }
  return updated;
}

/**
 * GenerateAndFillToken for tests/tools — the salted quadruple without a
 * runner row (the claim path uses the same shape for task tokens).
 */
export async function mintSaltedToken(): Promise<{ token: string; salt: string; hash: string }> {
  const token = cryptoRandomToken(20);
  const salt = cryptoRandomSalt();
  const hash = await hashRunnerToken(token, salt);
  return { token, salt, hash };
}
