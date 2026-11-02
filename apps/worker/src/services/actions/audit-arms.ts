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
 *
 * ## The impersonation derivation (the Wave K9 threading)
 *
 * Upstream attaches the admin behind an impersonated session at the record
 * seam itself: RecordAs derives `Impersonator: impersonatorRef(
 * ImpersonatorFromContext(ctx), doer)` (event.go:124), where
 * impersonatorRef drops the arm when the admin is absent or IS the doer and
 * otherwise snapshots {ID, Name} (refs.go:29-36), and buildEvent writes
 * ImpersonatorID/ImpersonatorName only when the ref is non-nil
 * (event.go:77-80). The context's admin is a FULL user object resolved at
 * auth time FROM THE SESSION's id backup with ONE GetUserByID — log and
 * continue when that lookup fails, "the session stays usable, but audit
 * events must not silently lose the admin behind it"
 * (routers/common/auth.go:37-45).
 *
 * Our session rows carry the id alone (migration 0058's
 * `impersonator_user_id`; the viewer's `impersonatorUserId`, ui/viewer.ts —
 * the name is not on the row), so the AuthShared derivation rides these
 * helpers: the arms accept the id-only form (`impersonatorUserId`) and
 * resolve the name with ONE `users` read, ONLY on the impersonated arm. A
 * vanished admin row degrades to ID-ONLY — the id stays on the audit row,
 * the name column goes null, the failure is logged, the emit still lands
 * (upstream's log-and-continue arm drops the admin entirely; keeping the id
 * is deliberate — the row stays attributable, refs.go's own fallback posture
 * "a failed lookup still yields a usable scope" applied to the actor ref).
 * The full `impersonator` snapshot stays for callers that already hold the
 * admin row (the session.ts exit seam resolves the pair in its own join).
 * The same-id fold is upstream's verbatim: a session whose admin id equals
 * the doer's records NOT impersonated (refs.go:31-36).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
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
   *  refs.go:31-36); absent/null = not impersonated. The FULL snapshot for
   *  callers that already hold the admin's name. */
  impersonator?: { id: number; username: string } | null;
  /** The id-only impersonation form — the viewer's `impersonatorUserId`
   *  (the session row carries the id alone, migration 0058). The helper
   *  derives the name with ONE users read, only on the impersonated arm
   *  (upstream AuthShared's GetUserByID, routers/common/auth.go:37-45); a
   *  vanished row degrades to id-only. Ignored when `impersonator` carries
   *  the full snapshot. */
  impersonatorUserId?: number | null;
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
  /** See WorkflowToggleAuditArm.impersonator. */
  impersonator?: { id: number; username: string } | null;
  /** See WorkflowToggleAuditArm.impersonatorUserId. */
  impersonatorUserId?: number | null;
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

/** The impersonation carrier both arms share (the actor plus either
 *  impersonation input form). */
interface WorkflowAuditImpersonation {
  actor: { id: number; username: string };
  impersonator?: { id: number; username: string } | null;
  impersonatorUserId?: number | null;
}

/** impersonatorRef's nil arm rendered in the row's zero shape
 *  (buildEvent leaves ImpersonatorID 0 / ImpersonatorName unset,
 *  event.go:77-80). */
const NOT_IMPERSONATED: { id: number; name: string | null } = { id: 0, name: null };

/**
 * impersonatorRef's port (refs.go:29-36) over the two input forms: the
 * full `{id, username}` snapshot wins; otherwise the id-only form
 * (`impersonatorUserId` — migration 0058's session column, the viewer's
 * field) derives the name with ONE users read, taken ONLY on the
 * impersonated arm (upstream AuthShared resolves the admin the same way,
 * routers/common/auth.go:37-45). The same-id fold is verbatim (refs.go:31-36:
 * the admin IS the doer ⇒ not impersonated). A vanished admin row (and a
 * failed read) degrade to ID-ONLY — logged, never thrown, so the audit row
 * still lands with its actor, scope, and message intact ("the session stays
 * usable, but audit events must not silently lose the admin behind it" —
 * ours keeps the id on the row where upstream drops it).
 */
async function resolveImpersonator(db: D1Database, arm: WorkflowAuditImpersonation): Promise<{ id: number; name: string | null }> {
  if (arm.impersonator !== null && arm.impersonator !== undefined) {
    return arm.impersonator.id === arm.actor.id ? NOT_IMPERSONATED : { id: arm.impersonator.id, name: arm.impersonator.username };
  }
  const id = arm.impersonatorUserId ?? 0;
  if (id === 0 || id === arm.actor.id) return NOT_IMPERSONATED; // refs.go:31-36's fold
  try {
    const row = await drizzle(db)
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, id))
      .get();
    if (row !== undefined) return { id, name: row.username };
    console.error(`actions: unable to resolve impersonator ${id}: no users row`);
  } catch (error) {
    console.error(`actions: unable to resolve impersonator ${id}`, error);
  }
  return { id, name: null };
}

/**
 * RecordWorkflowToggle's port (:53-60): the action by polarity, the repo
 * scope, metadata {"workflow"}, vars {workflow, scope}.
 */
export async function emitWorkflowToggleAudit(db: D1Database, arm: WorkflowToggleAuditArm): Promise<void> {
  try {
    const scopeName = repoFullName(arm.repo);
    const impersonator = await resolveImpersonator(db, arm);
    await emitAudit(drizzle(db), {
      action: arm.isEnable ? AuditActions.ActionsWorkflowEnable : AuditActions.ActionsWorkflowDisable,
      actorId: arm.actor.id,
      actorName: arm.actor.username,
      actorCredential: arm.actorCredential ?? null, // the web toggle rides a session
      impersonatorId: impersonator.id,
      impersonatorName: impersonator.name,
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
    const impersonator = await resolveImpersonator(db, arm);
    await emitAudit(drizzle(db), {
      action: AuditActions.ActionsWorkflowDispatch,
      actorId: arm.actor.id,
      actorName: arm.actor.username,
      actorCredential: arm.actorCredential ?? null,
      impersonatorId: impersonator.id,
      impersonatorName: impersonator.name,
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
