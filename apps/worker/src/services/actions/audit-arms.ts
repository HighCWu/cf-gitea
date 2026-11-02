/**
 * The Actions workflow toggle + dispatch audit emit arms (the v1.5.4 cycle —
 * Wave I-a's deferred family, services/audit.ts's `actions:workflow:*`
 * registry trio), the write-seam helpers the UI handlers and the API routes
 * call after a successful write. The services/oauth2/audit-arms.ts pattern:
 * standalone helpers over the `audit_event` seam, NOT mutations of the
 * orchestrator-owned handlers.
 *
 * Two shapes mirror upstream's two emit sites (pin
 * fc4936884584a41931906553d96c2601d750e6ef, services/actions/workflow.go):
 *
 *   - `emitWorkflowToggleAudit` — RecordWorkflowToggle (:53-60): the
 *     enable/disable pair by the toggle's polarity, scope = the repository
 *     (ScopeFromRepository, services/audit/refs.go:65-70 — id + FullName),
 *     metadata the single "workflow" pair, actor the doer. Upstream call
 *     sites: the web toggle (routers/web/repo/actions/view.go:1365 — AFTER
 *     UpdateRepoUnitConfig, before the Flash arms) and the API twin
 *     (EnableOrDisableWorkflow, workflow.go:49).
 *   - `emitWorkflowDispatchAudit` — DispatchActionWorkflow's tail
 *     (:192-193): audit.RecordAs(ctx, doer, ActionsWorkflowDispatch, repo,
 *     "workflow", workflowID, "ref", ref, "run_id", run.ID). The ref is the
 *     RAW form value (the function's `ref` parameter — NOT the
 *     RefName-normalized branch ref the run row stores), and run_id rides
 *     the metadata although the template does not name it (upstream keeps
 *     every parser key in the metadata; renderMessage resolves only the
 *     named tokens). The explicit-actor RecordAs is ported as the required
 *     `actor` snapshot.
 *
 * Both emit AFTER the write they describe succeeded (upstream's exact
 * positions above): a failed toggle/dispatch answers its error wire and the
 * helper is never reached — "a failed write emits nothing" without a
 * compensating delete.
 *
 * Failure posture: upstream's audit writeEvent LOGS failures and never fails
 * the request (services/audit/event.go:136-140) — every helper catches and
 * logs, the caller's response is unaffected (the oauth2 arms' posture).
 */

import { drizzle } from "drizzle-orm/d1";

import { AuditActions, emitAudit } from "../audit";

/** The repo projection the scope needs (ScopeFromRepository's
 *  EntityRef{repository, id, FullName}; the callers' rows — the UI
 *  `repositories` row and the API `pair.repo` — carry these verbatim). */
export interface WorkflowAuditRepo {
  id: string;
  ownerNamespace: string;
  slug: string;
}

/** The toggle arms' input (RecordWorkflowToggle's parameters plus the
 *  request context the AuditEventInput carries). */
export interface WorkflowToggleAuditArm {
  repo: WorkflowAuditRepo;
  /** The workflow id string (view.go:1365's form `workflow` / the API
   *  arm's workflow.ID — the ActionsConfig key, verbatim). */
  workflowId: string;
  /** The toggle polarity (view.go's disableOrEnableWorkflowFile's arg). */
  isEnable: boolean;
  /** The doer snapshot (audit.Record's context doer). */
  actor: { id: number; username: string };
  /** The web arm is "ui", the API twin "api" (upstream SetRequestInfo's
   *  origin, event.go:53-55). */
  origin?: "ui" | "api";
  ipAddress?: string | null;
  /** The acting credential ("access-token:<id>", audit_event.go:27's
   *  documented format; null when the write rode a session). */
  actorCredential?: string | null;
  /** The admin behind an impersonated session (impersonatorRef,
   *  refs.go:31-36); absent/null = not impersonated. */
  impersonator?: { id: number; username: string } | null;
}

/** The dispatch arm's input (DispatchActionWorkflow's :192-193 pairs). */
export interface WorkflowDispatchAuditArm {
  repo: WorkflowAuditRepo;
  workflowId: string;
  /** The RAW `ref` (the form value / API body field — workflow.go:193's
   *  own `ref`, before the RefName normalization). */
  ref: string;
  /** The inserted run's id (run.ID — numeric; accepted as a string too,
   *  the schema's scope_id drift posture). */
  runId: number | string;
  actor: { id: number; username: string };
  origin?: "ui" | "api";
  ipAddress?: string | null;
  actorCredential?: string | null;
  impersonator?: { id: number; username: string } | null;
}

/** ScopeFromRepository (refs.go:65-70): the repo's FullName — the
 *  owner-qualified path our rows carry as the namespace/slug pair. */
function repoFullName(repo: WorkflowAuditRepo): string {
  return `${repo.ownerNamespace}/${repo.slug}`;
}

/** The upstream writeEvent posture: log and swallow — the audit row must
 *  never fail the request that triggered it (event.go:136-140). */
function swallow(scope: string, error: unknown): void {
  console.error(`actions: unable to record the ${scope} audit event`, error);
}

/**
 * RecordWorkflowToggle's port (:53-60): the action by polarity, the repo
 * scope, metadata {"workflow"}, vars {workflow, scope}.
 */
export async function emitWorkflowToggleAudit(db: D1Database, arm: WorkflowToggleAuditArm): Promise<void> {
  try {
    const scopeName = repoFullName(arm.repo);
    await emitAudit(drizzle(db), {
      action: arm.isEnable ? AuditActions.ActionsWorkflowEnable : AuditActions.ActionsWorkflowDisable,
      actorId: arm.actor.id,
      actorName: arm.actor.username,
      actorCredential: arm.actorCredential ?? null, // the web toggle rides a session
      impersonatorId: arm.impersonator?.id ?? 0,
      impersonatorName: arm.impersonator?.username ?? null,
      scopeType: "repository",
      scopeId: arm.repo.id,
      scopeName,
      origin: arm.origin ?? "ui",
      ipAddress: arm.ipAddress ?? null,
      vars: { workflow: arm.workflowId, scope: scopeName },
      metadata: { workflow: arm.workflowId },
    });
  } catch (error) {
    swallow("workflow toggle", error);
  }
}

/**
 * DispatchActionWorkflow's audit tail (:192-193): the dispatch id, the RAW
 * ref var, and the metadata triple — keys in Go's json.Marshal map order
 * (sorted), run_id numeric like upstream's int64 pair.
 */
export async function emitWorkflowDispatchAudit(db: D1Database, arm: WorkflowDispatchAuditArm): Promise<void> {
  try {
    const scopeName = repoFullName(arm.repo);
    await emitAudit(drizzle(db), {
      action: AuditActions.ActionsWorkflowDispatch,
      actorId: arm.actor.id,
      actorName: arm.actor.username,
      actorCredential: arm.actorCredential ?? null,
      impersonatorId: arm.impersonator?.id ?? 0,
      impersonatorName: arm.impersonator?.username ?? null,
      scopeType: "repository",
      scopeId: arm.repo.id,
      scopeName,
      origin: arm.origin ?? "ui",
      ipAddress: arm.ipAddress ?? null,
      vars: { workflow: arm.workflowId, ref: arm.ref, scope: scopeName },
      // Go's json.Marshal sorts map keys: ref, run_id, workflow.
      metadata: { ref: arm.ref, run_id: arm.runId, workflow: arm.workflowId },
    });
  } catch (error) {
    swallow("workflow dispatch", error);
  }
}
