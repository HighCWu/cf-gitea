/**
 * The OAuth2-application + access-token audit emit arms (v1.5.2 ledger §1.3
 * F3 — the audit family for the OAuth2-app CRUD/revoke and the PAT panel),
 * the write-seam helpers the routes and the settings pages call after a
 * successful write.
 *
 * Two shapes mirror upstream's two Record entry points:
 *
 *   - `emitOAuth2ApplicationAudit` — services/audit/scoped.go:108-131's
 *     RecordScoped over the OAuth2Application ScopedActions (:39-63): the
 *     action variant and scope follow the OWNER (an organization row ⇒ the
 *     organization:* variant, uid 0 / a missing row ⇒ the system:* variant,
 *     otherwise the user:* variant). Metadata is the alternating pair the
 *     handlers pass ("oauth2_application", app.Name).
 *   - `emitAccessTokenAudit` — audit.Record(ctx, UserAccessTokenAdd/Remove,
 *     owner, "token", t.Name [, "token_scope", t.Scope]) (applications.go:133
 *     web / app.go:156 API for the add; :162/:231 for the remove): actor =
 *     scope = the token's owner, always the user variants.
 *
 * The actor snapshot: upstream's actor is the DOER (the signed-in user) —
 * identical to the owner on every user-scoped surface these arms serve
 * today (the settings pages operate on the doer's own resources; the web
 * user twin's handlers run as the owner). The `actor` field threads an
 * explicit doer snapshot so the org/admin twin handlers can carry the real
 * acting user once their mounts thread `p.viewer`; absent, the helper
 * falls back to the resolved owner row (the org twin renders the org row —
 * the message text stays exact, only the actor snapshot approximates; the
 * admin twin carries the empty-name posture, the AuditEventInput contract's
 * "'' when the caller has no resolved name").
 *
 * Failure posture: upstream's audit writeEvent LOGS failures and never
 * fails the request (services/audit/event.go:136-140) — every helper
 * catches and logs, the caller's response is unaffected (the W7
 * oauth2-login emit's posture).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users, type users as UsersTable } from "../../db/schema";
import { AuditActions, emitAudit } from "../audit";

type UserRow = typeof UsersTable.$inferSelect;

/** The OAuth2-application verbs (oauth2_common.go's recordAudit call sites:
 *  :77 add, :143 update, :170 secret, :189 remove, :220 revoke). */
export type OAuth2ApplicationAuditVerb = "add" | "update" | "secret" | "remove" | "revoke";

/** The owner row projection the scope selection needs (ScopeFromUser's half,
 *  services/audit/refs.go:38-46 — an org user row renders the organization
 *  scope; cf-gitea's `users.type` carries the org kind). */
type AuditOwnerRow = Pick<UserRow, "id" | "username" | "type">;

export interface OAuth2ApplicationAuditArm {
  /** The `uid` column of the application — 0 is the instance-wide admin
   *  sentinel (oauth2_common.go:21-33's ownerID: the nil Owner). */
  ownerId: number;
  appName: string;
  verb: OAuth2ApplicationAuditVerb;
  origin: "ui" | "api";
  ipAddress?: string | null;
  /** The doer snapshot (see the module header). */
  actor?: { id: number; username: string };
  /** The acting credential (the API token arms' "access-token:<id>",
   *  audit_event.go:27's documented format; session writes pass null). */
  actorCredential?: string | null;
}

/** RecordScoped's OAuth2Application ScopedActions (scoped.go:39-63): the
 *  verb's action per scope kind. Revoke carries ONLY the user variant
 *  (scoped.go:58-60 — grants belong to individuals). */
const APPLICATION_ACTIONS: Record<OAuth2ApplicationAuditVerb, { user: string; org?: string; system?: string }> = {
  add: { user: AuditActions.UserOAuth2ApplicationAdd, org: AuditActions.OrganizationOAuth2ApplicationAdd, system: AuditActions.SystemOAuth2ApplicationAdd },
  update: { user: AuditActions.UserOAuth2ApplicationUpdate, org: AuditActions.OrganizationOAuth2ApplicationUpdate, system: AuditActions.SystemOAuth2ApplicationUpdate },
  secret: { user: AuditActions.UserOAuth2ApplicationSecret, org: AuditActions.OrganizationOAuth2ApplicationSecret, system: AuditActions.SystemOAuth2ApplicationSecret },
  remove: { user: AuditActions.UserOAuth2ApplicationRemove, org: AuditActions.OrganizationOAuth2ApplicationRemove, system: AuditActions.SystemOAuth2ApplicationRemove },
  revoke: { user: AuditActions.UserOAuth2ApplicationRevoke },
};

/** The PAT verbs (applications.go:133/:162 — the web arms; app.go:156/:231
 *  are the API twins with the same ids). */
export type AccessTokenAuditVerb = "add" | "remove";

export interface AccessTokenAuditArm {
  /** The token's owner (upstream `owner` / `ctx.ContextUser`). */
  userId: number;
  tokenName: string;
  /** The normalized scope string — the add arm's "token_scope" pair
   *  (upstream renders t.Scope, the AccessTokenScope string). */
  tokenScope?: string;
  verb: AccessTokenAuditVerb;
  origin: "ui" | "api";
  ipAddress?: string | null;
  actor?: { id: number; username: string };
  actorCredential?: string | null;
}

/** Load the owner row (the scope + the actor fallback's source). */
async function loadOwnerRow(db: D1Database, userId: number): Promise<AuditOwnerRow | null> {
  const row = await drizzle(db)
    .select({ id: users.id, username: users.username, type: users.type })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row ?? null;
}

/** The upstream writeEvent posture: log and swallow — the audit row must
 *  never fail the request that triggered it (event.go:136-140). */
function swallow(scope: string, error: unknown): void {
  console.error(`oauth2: unable to record the ${scope} audit event`, error);
}

/**
 * The OAuth2-application write arms' emit — the RecordScoped port. Resolve
 * the owner row, select the variant, render the template's vars (the
 * system:* templates carry no {scope} token), emit.
 */
export async function emitOAuth2ApplicationAudit(db: D1Database, arm: OAuth2ApplicationAuditArm): Promise<void> {
  try {
    const owner = await loadOwnerRow(db, arm.ownerId);
    const actions = APPLICATION_ACTIONS[arm.verb];
    const scopeType: "user" | "organization" | "system" = owner === null ? "system" : owner.type === "org" ? "organization" : "user";
    const action = scopeType === "organization" ? (actions.org ?? actions.user) : scopeType === "system" ? (actions.system ?? actions.user) : actions.user;
    // The template vars: the user/org templates carry {oauth2_application}
    // and {scope}; the system templates carry only {oauth2_application}.
    const scopeName = owner?.username ?? "";
    const vars: Record<string, string> = { oauth2_application: arm.appName };
    if (scopeType !== "system") {
      vars.scope = scopeName;
    }
    const actor = arm.actor ?? { id: owner?.id ?? 0, username: scopeName };
    await emitAudit(drizzle(db), {
      action,
      actorId: actor.id,
      actorName: actor.username,
      actorCredential: arm.actorCredential ?? null, // the settings writes ride a session
      scopeType,
      scopeId: owner === null ? "" : owner.id,
      scopeName: owner === null ? null : scopeName,
      origin: arm.origin,
      ipAddress: arm.ipAddress ?? null,
      vars,
      metadata: { oauth2_application: arm.appName },
    });
  } catch (error) {
    swallow("oauth2 application", error);
  }
}

/**
 * The access-token add/remove emit — audit.Record with owner as the scope
 * (applications.go:133/:162, app.go:156/:231). Message vars: the add
 * template's three tokens {token}/{scope}/{token_scope}, the remove
 * template's two.
 */
export async function emitAccessTokenAudit(db: D1Database, arm: AccessTokenAuditArm): Promise<void> {
  try {
    const owner = await loadOwnerRow(db, arm.userId);
    const username = owner?.username ?? "";
    const action = arm.verb === "add" ? AuditActions.UserAccessTokenAdd : AuditActions.UserAccessTokenRemove;
    const vars: Record<string, string> = { token: arm.tokenName, scope: username };
    if (arm.verb === "add") {
      vars.token_scope = arm.tokenScope ?? "";
    }
    const actor = arm.actor ?? { id: arm.userId, username };
    await emitAudit(drizzle(db), {
      action,
      actorId: actor.id,
      actorName: actor.username,
      actorCredential: arm.actorCredential ?? null,
      scopeType: "user",
      scopeId: arm.userId,
      scopeName: username,
      origin: arm.origin,
      ipAddress: arm.ipAddress ?? null,
      vars,
      metadata: arm.verb === "add" ? { token: arm.tokenName, token_scope: arm.tokenScope ?? "" } : { token: arm.tokenName },
    });
  } catch (error) {
    swallow("access token", error);
  }
}
