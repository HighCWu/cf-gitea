/**
 * The Actions OIDC issuer (SPEC-0012 §2.7, M1b) — the three GETs under
 * /api/actions/oidc (routers/api/actions/actions.go:16-20) and the token
 * exchange behind them, ported from routers/api/actions/oidc.go +
 * services/actions/oidc.go.
 *
 * The claim set mirrors GitHub's (services/actions/oidc.go:56-82): the
 * immutable-ID subject, 5-minute expiry with a 5-minute not-before
 * backdating, runner_environment "self-hosted". The workflow-file legs of
 * the upstream claims (runWorkflowFile's name read from git) resolve to the
 * stored workflow identity in v1 — the workflow parser is M3's, and the
 * run's workflow_id/path is what the run row carries (upstream's own
 * fallback when the YAML has no name, oidc.go:238-241).
 *
 * /token is a TOKEN EXCHANGE, not OAuth2: the bearer is the short-scoped
 * Actions.IDTokenRequest JWT minted at claim time (dispatch.ts), permitted
 * only while the task is running/cancelling AND the job's token_permissions
 * grant id-token (taskAllowsOIDCToken, services/actions/oidc.go:115-124 —
 * null permissions deny, the v1 posture with the M3 parser away).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionRuns, actionTasks } from "../../db/schema";
import { goPathEscape } from "../packages/npm";
import { getRepoById, getUserById, type RepoRecord, type RunJobRow, type RunRow } from "./model";
import { OIDC_SIGNING_ALGORITHM, oidcClaimsSupported, oidcIssuer, oidcPublicJwk, signOIDCToken, taskIdFromToken } from "./secrets";

type C = Context<{ Bindings: Env }>;

/** The row fields the claim set reads (Picks keep the test seeds honest). */
export type OidcRunFields = Pick<
  RunRow,
  "id" | "repoId" | "index" | "triggerUserId" | "ref" | "commitSha" | "triggerEvent" | "eventPayload" | "workflowId" | "workflowCommitSha" | "isForkPullRequest"
>;
export type OidcJobFields = Pick<RunJobRow, "attempt" | "tokenPermissions">;

/** createOIDCClaims' claims shape (services/actions/oidc.go:24-54). */
export interface OidcClaims extends Record<string, unknown> {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  actor: string;
  actor_id: string;
  repository: string;
  repository_id: string;
  repository_owner: string;
  repository_owner_id: string;
  repository_visibility: string;
  run_id: string;
  run_number: string;
  run_attempt: string;
  event_name: string;
  ref: string;
  ref_type: string;
  ref_protected: string;
  sha: string;
  base_ref: string;
  head_ref: string;
  workflow: string;
  workflow_ref: string;
  workflow_sha: string;
  job_workflow_ref: string;
  job_workflow_sha: string;
  runner_environment: string;
}

/**
 * taskAllowsOIDCToken (services/actions/oidc.go:115-124): the job's stored
 * token_permissions JSON must grant id_token. The M1b port reads the row's
 * JSON directly — the ComputeTaskTokenPermissions clamp lands with the
 * actions-config settings family (M1c/M3); a null payload denies, which is
 * exactly upstream's first branch.
 */
export function taskAllowsOidcToken(job: OidcJobFields): boolean {
  if (job.tokenPermissions === null || job.tokenPermissions === undefined) {
    return false;
  }
  try {
    const parsed = JSON.parse(job.tokenPermissions) as { id_token?: unknown };
    return parsed.id_token === true;
  } catch {
    return false;
  }
}

/** The contextString inputs (createOIDCClaims' GenerateGiteaContext legs). */
interface ClaimInputs {
  run: OidcRunFields;
  job: OidcJobFields;
  repo: RepoRecord | null;
  actor: string;
  ref: string;
  refType: string;
  baseRef: string;
  headRef: string;
  sha: string;
  eventName: string;
  /** The AppURL — origin WITH the trailing slash (setting.AppURL's shape,
   *  `appUrlOf`). The audience composition below relies on the slash. */
  appUrl: string;
}

/**
 * createOidcClaims (services/actions/oidc.go:128-181): the GitHub-shaped
 * claim set over the stored rows.
 */
export function createOidcClaims(inputs: ClaimInputs, audience: string, now: Date): OidcClaims {
  const { run, job, repo, appUrl } = inputs;
  const ownerNamespace = repo?.ownerNamespace ?? "";
  const fullName = `${ownerNamespace}/${repo?.slug ?? ""}`;

  // GitHub's immutable format — the IDs keep a recreated owner or repo name
  // from matching (oidc.go:171-178):
  // repo:<OwnerName>@<OwnerID>/<Name>@<RepoID> — the owner segment carries
  // the owner NAME alone, not the full name.
  let subject = `repo:${ownerNamespace}@${repo?.ownerId ?? 0}/${repo?.slug ?? ""}@${run.repoId}`;
  if (run.triggerEvent === "pull_request") {
    subject += ":pull_request";
  } else {
    subject += `:ref:${inputs.ref}`;
  }
  if (audience === "") {
    // setting.AppURL + url.PathEscape(run.Repo.OwnerName) (oidc.go:179-182) —
    // the AppURL keeps its trailing slash: https://host/<owner>.
    audience = `${appUrl}${goPathEscape(ownerNamespace)}`;
  }
  const visibility =
    repo?.visibility === "public" ? "public" : repo?.visibility === "internal" ? "internal" : "private";

  const workflowPath = run.workflowId;
  const workflowSha = run.workflowCommitSha !== "" ? run.workflowCommitSha : run.commitSha;
  // runWorkflowFile's fallback name: the file path when the workflow has no
  // name — the v1 posture (the parser is M3's).
  const workflowName = workflowPath;
  const rootWorkflowRef = `${fullName}/${workflowPath}@${inputs.ref}`;

  const seconds = Math.floor(now.getTime() / 1000);
  return {
    iss: oidcIssuer(appUrl),
    sub: subject,
    aud: audience,
    exp: seconds + 5 * 60,
    nbf: seconds - 5 * 60, // backdated like GitHub for skewed clocks
    iat: seconds,
    jti: crypto.randomUUID(),
    actor: inputs.actor,
    actor_id: String(run.triggerUserId),
    repository: fullName,
    repository_id: String(run.repoId),
    repository_owner: ownerNamespace,
    repository_owner_id: String(repo?.ownerId ?? 0),
    repository_visibility: visibility,
    run_id: String(run.id),
    run_number: String(run.index),
    run_attempt: String(job.attempt),
    event_name: inputs.eventName,
    ref: inputs.ref,
    ref_type: inputs.refType,
    ref_protected: "false", // the SPEC-0013 protected-ref match lands at M3
    sha: inputs.sha,
    base_ref: inputs.baseRef,
    head_ref: inputs.headRef,
    workflow: workflowName,
    workflow_ref: rootWorkflowRef,
    workflow_sha: workflowSha,
    job_workflow_ref: rootWorkflowRef,
    job_workflow_sha: workflowSha,
    runner_environment: "self-hosted",
  };
}

/**
 * CreateOIDCToken (services/actions/oidc.go:108-146): verify the request
 * token, check the task's liveness + permission, mint the RS256 ID token.
 * Throws PermissionDeniedError for the WWW-Authenticate arm.
 */
export async function createOidcToken(env: Env, requestToken: string, audience: string, appUrl: string): Promise<string> {
  let taskId: number;
  try {
    taskId = await taskIdFromToken(env, requestToken, true);
  } catch {
    throw new PermissionDeniedError("invalid ID token request token");
  }

  const db = drizzle(env.DB);
  const taskRows = await db.select().from(actionTasks).where(eq(actionTasks.id, taskId)).limit(1);
  const task = taskRows[0];
  if (task === undefined) {
    throw new PermissionDeniedError(`task ${taskId} does not exist`);
  }
  // Cleanup steps of cancelled jobs may still need one (oidc.go:121-122).
  if (task.status !== 6 && task.status !== 8) {
    throw new PermissionDeniedError(`task ${taskId} is not active`);
  }
  const jobRows = await db.select().from(actionRunJobs).where(eq(actionRunJobs.id, task.jobId)).limit(1);
  const job = jobRows[0];
  if (job === undefined) {
    throw new Error("actions: job missing for oidc task");
  }
  if (!taskAllowsOidcToken(job)) {
    throw new PermissionDeniedError(`task ${taskId} lacks the id-token permission`);
  }

  const runRows = await db.select().from(actionRuns).where(eq(actionRuns.id, job.runId)).limit(1);
  const run = runRows[0];
  if (run === undefined) {
    throw new Error("actions: run missing for oidc task");
  }
  const repo = await getRepoById(env.DB, job.repoId);
  const triggerUser = run.triggerUserId > 0 ? await getUserById(env.DB, run.triggerUserId) : null;

  // The claim inputs re-derive the GenerateGiteaContext fields from stored
  // rows (context.go's payload-driven slice — dispatch.ts's refParts shape).
  const payload = (() => {
    try {
      return JSON.parse(run.eventPayload) as { pull_request?: { base?: { ref?: string; sha?: string }; head?: { ref?: string } } };
    } catch {
      return {};
    }
  })();
  let ref = run.ref;
  let sha = run.commitSha;
  let baseRef = "";
  let headRef = "";
  if (payload.pull_request?.base?.ref !== undefined) {
    baseRef = payload.pull_request.base.ref;
    headRef = payload.pull_request.head?.ref ?? "";
    if (run.triggerEvent === "pull_request_target") {
      ref = `refs/heads/${baseRef}`;
      sha = payload.pull_request.base.sha ?? sha;
    }
  }

  const claims = createOidcClaims(
    {
      run,
      job,
      repo,
      actor: triggerUser?.username ?? "",
      ref,
      refType: ref.startsWith("refs/tags/") ? "tag" : ref.startsWith("refs/") ? "branch" : "",
      baseRef,
      headRef,
      sha,
      eventName: run.triggerEvent,
      appUrl,
    },
    audience,
    new Date(),
  );
  return signOIDCToken(env, claims);
}

export class PermissionDeniedError extends Error {}

// ---------------------------------------------------------------------------
// The three GETs (routers/api/actions/oidc.go)
// ---------------------------------------------------------------------------

export function createOidcRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  r.get("/.well-known/openid-configuration", (c) => {
    const issuer = oidcIssuer(appUrlOf(c));
    return c.json({
      issuer,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [OIDC_SIGNING_ALGORITHM],
      claims_supported: oidcClaimsSupported(),
      scopes_supported: ["openid"],
    });
  });

  r.get("/jwks", async (c) => {
    const jwk = await oidcPublicJwk(c.env);
    return c.json({ keys: [jwk] });
  });

  r.get("/token", async (c) => {
    let token = "";
    const auth = c.req.header("Authorization") ?? "";
    if (auth.startsWith("Bearer ")) {
      token = auth.slice("Bearer ".length);
    }
    const audience = c.req.query("audience") ?? "";
    let idToken: string;
    try {
      idToken = await createOidcToken(c.env, token, audience, appUrlOf(c));
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        c.header("WWW-Authenticate", "Bearer");
        return c.text("Unauthorized", 401);
      }
      return c.text("Internal Server Error", 500);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ value: idToken });
  });

  return r;
}

function appUrlOf(c: C): string {
  return new URL(c.req.url).origin + "/";
}
