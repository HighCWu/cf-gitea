import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actionRunAttempts,
  actionRunJobs,
  actionRunners,
  actionRuns,
  actionTaskSteps,
  actionTasks,
  actionVariables,
  issues,
  PRFlow,
  pullRequests,
  repositories,
  secrets,
  users,
} from "../../db/schema";
import type { PullRequestRow } from "../../issues/service";
import { ApiError } from "../errors";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_PENDING,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  getRunnerById,
  increaseTaskVersion,
  updateRunner,
  type RunAttemptRow,
  type RunnerRow,
  type RunJobRow,
  type RunRow,
} from "../../services/actions/model";
import {
  canViewRepository,
  findRepositoriesByIds,
  GO_ZERO_TIME,
  toApiRepository,
  viewerTeamAccessModes,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "./repository";
import { toApiUser } from "./user";

/**
 * The actions secrets/variables/runners service — the upstream `secret` +
 * `action_variable` stores behind the three `/actions` scopes (the inventory
 * batch `wave-api-secrets-variables`, 23 operations), extended with the
 * runner registration/management mapping for the same three scopes (P1-7,
 * routers/api/v1/shared/runners.go — 15 more operations; storage rides the
 * landed control-plane primitives in services/actions/model.ts) and with the
 * workflow runs/jobs LISTING family (P1-8, routers/api/v1/shared/action.go —
 * 6 more operations over the landed action_runs/action_run_jobs store; its
 * own anchor block rides the section below). Upstream anchors, per-function:
 *
 *   - validateSecretName     — secrets.ValidateName
 *                              (services/secrets/validation.go:24-36)
 *   - createOrUpdateSecret   — secrets.CreateOrUpdateSecret
 *                              (services/secrets/secrets.go:14-41) over
 *                              InsertEncryptedSecret / UpdateSecret
 *                              (models/secret/secret.go:67-90, 132-152)
 *   - deleteSecretByName     — secrets.DeleteSecretByName
 *                              (services/secrets/secrets.go:55-64; the miss
 *                              carries ErrSecretNotFound{} — models/secret/
 *                              secret.go:48-59 — whose EMPTY Name field makes
 *                              the wire message "secret was not found
 *                              [name: ]")
 *   - listSecretRows         — FindSecretsOptions (models/secret/secret.go:107-130,
 *                              ToOrders "name")
 *   - getVariableRow         — actions_service.GetVariable
 *                              (services/actions/variables.go:50-59 — "!= 1
 *                              row" → the exact "variable not found" message)
 *   - createVariableRow      — actions_service.CreateVariable
 *                              (services/actions/variables.go:14-25) over
 *                              InsertVariable (models/actions/variable.go:44-61)
 *   - updateVariableRow      — the UpdateVariable handler sequence
 *                              (routers/api/v1/repo/action.go:399-423) over
 *                              UpdateVariableNameData
 *                              (services/actions/variables.go:27-35)
 *   - deleteVariableRow      — actions_service.DeleteVariableByName
 *                              (services/actions/variables.go:41-48)
 *   - listVariableRows       — FindVariablesOpts (models/actions/variable.go:68-100,
 *                              ToOrders "name")
 *
 * RUNNER ANCHORS (the P1-7 extension):
 *
 *   - runnerStatusOf         — ActionRunner.Status (models/actions/runner.go:127-135)
 *                              over RunnerOfflineTime/RunnerIdleTime (:76-77)
 *   - toApiRunner            — convert.ToActionRunner
 *                              (services/convert/convert.go:793-814)
 *   - listRunnerRows         — shared.ListRunners
 *                              (routers/api/v1/shared/runners.go:41-66) over
 *                              FindRunnerOptions (runner.go:224-315; the
 *                              default status-rank order at :315)
 *   - findRunnerInContext    — getRunnerByID + EditableInContext
 *                              (shared/runners.go:68-84; runner.go:158-169)
 *   - runnerMissMessage      — GetRunnerByID's wrapped not-exist
 *                              (runner.go:336) through util.ErrorUnwrapForUser
 *                              (util/error.go:26,43-48)
 *   - setRunnerDisabled      — SetRunnerDisabled (runner.go:354-366)
 *
 * SCOPE ENCODING (upstream's own rule, models/secret/secret.go:25-33) — a
 * repo-level row is `{ownerId: 0, repoId}`; an org/user-level row is
 * `{ownerId, repoId: ""}` (upstream's 0 sentinel, adapted to the landed TEXT
 * repositories.id). Never both non-empty; never both empty.
 *
 * THE AT-REST DIVERGENCE — upstream stores secret `data` encrypted with the
 * instance SecretKey (EncryptSecret → AesEncrypt CFB,
 * models/secret/secret.go:20-55, 57-66). cf-gitea has no instance-key model
 * yet (the settings-module seam, services/hooks.ts:488-491's
 * headerAuthorizationEncrypted precedent), so the column stores plaintext.
 * The API NEVER returns secret data — the `Secret` wire shape
 * (modules/structs/secret.go:10-17) carries name/description/created_at only
 * — so the divergence is invisible to the contract and gated on the same
 * future settings SPEC.
 *
 * LENGTH UNITS — secrets count `data` in BYTES (Go len,
 * models/secret/secret.go:69, 133); variables count it in RUNES
 * (utf8.RuneCountInString, models/actions/variable.go:45, 79). Descriptions
 * truncate at 4096 runes in both stores (TruncateRunes). Variable values are
 * EOL-normalized ("\r\n" → "\n", NormalizeStringEOL,
 * modules/util/util.go:312) at insert and update; secret data is not.
 */

/** Upstream caps (models/secret/secret.go:46-47, models/actions/variable.go:39-40). */
export const SECRET_DATA_MAX_BYTES = 65536;
export const VARIABLE_DATA_MAX_RUNES = 65536;
const DESCRIPTION_MAX_RUNES = 4096;

/** The scope pair (see the module header). */
export interface SecretScope {
  ownerId: number;
  repoId: string;
}

/** BelongingScopeRepo — `{owner: 0, repo}`. */
export function repoScope(repoId: string): SecretScope {
  return { ownerId: 0, repoId };
}

/** BelongingScopeOwner — `{owner, repo: ''}`. */
export function ownerScope(ownerId: number): SecretScope {
  return { ownerId, repoId: "" };
}

export type SecretRow = typeof secrets.$inferSelect;
export type VariableRow = typeof actionVariables.$inferSelect;

// ---------------------------------------------------------------------------
// Name validation (services/secrets/validation.go) — shared by BOTH stores
// (actions_service.CreateVariable calls secret_service.ValidateName).
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const FORBIDDEN_PREFIX = /^(GITEA_|GITHUB_)/i;

/**
 * ValidateName — the GitHub naming conventions upstream cites
 * (validation.go:18-22). Every failure is util.ErrInvalidArgument → the
 * APIErrorAuto 400 arm, with the exact Go texts.
 */
export function validateSecretName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError(
      400,
      "name must start with a letter or underscore and contain only letters, numbers, and underscores",
    );
  }
  if (FORBIDDEN_PREFIX.test(name)) {
    throw new ApiError(400, "name cannot start with 'GITEA_' or 'GITHUB_'");
  }
  if (name.toLowerCase() === "ci") {
    throw new ApiError(400, "'CI' is a reserved name");
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** utf8.RuneCountInString — code points, not UTF-16 units. */
function runeCount(s: string): number {
  return [...s].length;
}

/** TruncateRunes (modules/util/truncate.go:127-133). */
function truncateRunes(str: string, limit: number): string {
  if (runeCount(str) < limit) {
    return str;
  }
  return [...str].slice(0, limit).join("");
}

/** NormalizeStringEOL (modules/util/util.go:312-320). */
function normalizeStringEol(input: string): string {
  return input.replaceAll("\r\n", "\n");
}

/** strings.ToUpper at insert and lookup (InsertEncryptedSecret / FindSecretsOptions
 *  / InsertVariable / FindVariablesOpts all normalize the same way). */
function normalizedName(name: string): string {
  return name.toUpperCase();
}

/**
 * The numeric rendering of a TEXT repositories.id for the contract's int64
 * `repo_id` field (the repositoryIdNumber seam — services/repository.ts:267,
 * module-private there; verbatim duplicate per the admin-org-extras seam
 * note). Numeric text ids pass through; anything else renders 0.
 */
function repoIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** The scope WHERE arm shared by both stores (FindSecretsOptions.ToConds /
 *  FindVariablesOpts.ToConds): filter by repo_id, and pin owner_id to 0 when
 *  the scope is a repo — "ignore OwnerID and treat it as 0". */
function scopeCond(scope: SecretScope) {
  return scope.repoId !== ""
    ? and(eq(secrets.repoId, scope.repoId), eq(secrets.ownerId, 0))
    : and(eq(secrets.repoId, ""), eq(secrets.ownerId, scope.ownerId));
}

function variableScopeCond(scope: SecretScope) {
  return scope.repoId !== ""
    ? and(eq(actionVariables.repoId, scope.repoId), eq(actionVariables.ownerId, 0))
    : and(eq(actionVariables.repoId, ""), eq(actionVariables.ownerId, scope.ownerId));
}

/** "data too long" — the InvalidArgument text both stores 400 with
 *  (secret.go:70, 134; variable.go:46, 80). */
function dataTooLong(): ApiError {
  return new ApiError(400, "data too long");
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * CreateOrUpdateSecret (services/secrets/secrets.go:14-41): validate the
 * name, find by (scope, UPPER(name)); a miss inserts (201 arm), a hit
 * updates data + description (204 arm). `data` counts BYTES against
 * SecretDataMaxLength in both arms; the description truncates at 4096 runes.
 */
export async function createOrUpdateSecret(
  d1: D1Database,
  scope: SecretScope,
  name: string,
  data: string,
  description: string,
): Promise<{ row: SecretRow; created: boolean }> {
  validateSecretName(name);
  const normalized = normalizedName(name);
  if (new TextEncoder().encode(data).length > SECRET_DATA_MAX_BYTES) {
    throw dataTooLong();
  }
  const truncatedDescription = truncateRunes(description, DESCRIPTION_MAX_RUNES);
  const now = new Date();
  const existing = await drizzle(d1)
    .select()
    .from(secrets)
    .where(and(scopeCond(scope), eq(secrets.name, normalized)))
    .limit(1);
  if (existing.length > 0) {
    const row = existing[0]!;
    // UpdateSecret (secret.go:132-152) — data + description only.
    const updated = await drizzle(d1)
      .update(secrets)
      .set({ data, description: truncatedDescription })
      .where(eq(secrets.id, row.id))
      .returning();
    return { row: updated[0]!, created: false };
  }
  const inserted = await drizzle(d1)
    .insert(secrets)
    .values({
      ownerId: scope.ownerId,
      repoId: scope.repoId,
      name: normalized,
      data,
      description: truncatedDescription,
      createdAt: now,
    })
    .returning();
  return { row: inserted[0]!, created: true };
}

/**
 * DeleteSecretByName (services/secrets/secrets.go:55-64): find by
 * (scope, UPPER(name)); the miss answers ErrSecretNotFound{} — upstream
 * constructs it with the EMPTY name field, so the 404 message is the
 * bracketed empty rendering below (secret.go:55-57 Error()).
 */
export async function deleteSecretByName(d1: D1Database, scope: SecretScope, name: string): Promise<SecretRow | null> {
  const normalized = normalizedName(name);
  const existing = await drizzle(d1)
    .select()
    .from(secrets)
    .where(and(scopeCond(scope), eq(secrets.name, normalized)))
    .limit(1);
  if (existing.length === 0) {
    return null;
  }
  await drizzle(d1).delete(secrets).where(eq(secrets.id, existing[0]!.id));
  return existing[0] ?? null;
}

/** FindSecretsOptions — name-ordered, paginated (ToOrders "name"). */
export async function listSecretRows(
  d1: D1Database,
  scope: SecretScope,
  page: number,
  limit: number,
): Promise<{ rows: SecretRow[]; total: number }> {
  const totals = await drizzle(d1).select({ value: count() }).from(secrets).where(scopeCond(scope));
  const rows = await drizzle(d1)
    .select()
    .from(secrets)
    .where(scopeCond(scope))
    .orderBy(asc(secrets.name))
    .limit(limit)
    .offset((page - 1) * limit);
  return { rows, total: totals[0]?.value ?? 0 };
}

/** The wire `Secret` (modules/structs/secret.go:10-17) — data never renders. */
export function toApiSecret(row: SecretRow): { name: string; description: string; created_at: string } {
  return {
    name: row.name,
    description: row.description,
    created_at: row.createdAt.toISOString(),
  };
}

/** ErrSecretNotFound{} — the empty-name Error() text (secret.go:55-57). */
export function secretNotFoundMessage(): string {
  return "secret was not found [name: ]";
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/**
 * GetVariable (services/actions/variables.go:50-59): exactly one row by
 * (scope, UPPER(name)) or the "variable not found" NotExist → 404.
 */
export async function getVariableRow(d1: D1Database, scope: SecretScope, name: string): Promise<VariableRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(actionVariables)
    .where(and(variableScopeCond(scope), eq(actionVariables.name, normalizedName(name))))
    .limit(1);
  return rows[0] ?? null;
}
/** The GetVariable miss — util.NewNotExistErrorf("variable not found"). */
export function variableNotFoundMessage(): string {
  return "variable not found";
}

/**
 * InsertVariable (models/actions/variable.go:44-61): validate, rune-count the
 * value against VariableDataMaxLength, truncate the description, EOL-normalize,
 * store the UPPERCASE name. (The 409 already-exists arm is the route's
 * pre-check, mirroring the upstream handler order — action.go:341-352.)
 */
export async function createVariableRow(
  d1: D1Database,
  scope: SecretScope,
  name: string,
  value: string,
  description: string,
): Promise<VariableRow> {
  validateSecretName(name);
  if (runeCount(value) > VARIABLE_DATA_MAX_RUNES) {
    throw dataTooLong();
  }
  const now = new Date();
  const inserted = await drizzle(d1)
    .insert(actionVariables)
    .values({
      ownerId: scope.ownerId,
      repoId: scope.repoId,
      name: normalizedName(name),
      data: normalizeStringEol(value),
      description: truncateRunes(description, DESCRIPTION_MAX_RUNES),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted[0]!;
}

/**
 * The UpdateVariable handler sequence (routers/api/v1/repo/action.go:399-423):
 * find by the PATH name (404 arm), overwrite name/data/description — an
 * absent optional field carries Go's zero value, so `description: undefined`
 * CLEARS the stored description exactly like upstream — then
 * UpdateVariableNameData re-validates the (possibly renamed) name and
 * EOL-normalizes the value. A rename onto an existing name violates the
 * UNIQUE triple upstream too (its plain 500 internal; ours lands in the
 * generic error handler the same way).
 */
export async function updateVariableRow(
  d1: D1Database,
  scope: SecretScope,
  name: string,
  newName: string | undefined,
  value: string,
  description: string | undefined,
): Promise<VariableRow | null> {
  const existing = await getVariableRow(d1, scope, name);
  if (existing === null) {
    return null;
  }
  const finalName = normalizedName(newName === undefined || newName === "" ? existing.name : newName);
  validateSecretName(finalName);
  if (runeCount(value) > VARIABLE_DATA_MAX_RUNES) {
    throw dataTooLong();
  }
  const updated = await drizzle(d1)
    .update(actionVariables)
    .set({
      name: finalName,
      data: normalizeStringEol(value),
      description: description ?? "",
      updatedAt: new Date(),
    })
    .where(eq(actionVariables.id, existing.id))
    .returning();
  return updated[0]!;
}

/** DeleteVariableByName (services/actions/variables.go:41-48): find (404 arm)
 *  then delete; returns the deleted row (the route 204s either way). */
export async function deleteVariableRow(d1: D1Database, scope: SecretScope, name: string): Promise<VariableRow | null> {
  const existing = await getVariableRow(d1, scope, name);
  if (existing === null) {
    return null;
  }
  await drizzle(d1).delete(actionVariables).where(eq(actionVariables.id, existing.id));
  return existing;
}
/** FindVariablesOpts — name-ordered, paginated (ToOrders "name"). */
export async function listVariableRows(
  d1: D1Database,
  scope: SecretScope,
  page: number,
  limit: number,
): Promise<{ rows: VariableRow[]; total: number }> {
  const totals = await drizzle(d1).select({ value: count() }).from(actionVariables).where(variableScopeCond(scope));
  const rows = await drizzle(d1)
    .select()
    .from(actionVariables)
    .where(variableScopeCond(scope))
    .orderBy(asc(actionVariables.name))
    .limit(limit)
    .offset((page - 1) * limit);
  return { rows, total: totals[0]?.value ?? 0 };
}

/** The wire `ActionVariable` (modules/structs/variable.go:38-49) — every
 *  field serializes (no omitempty); `repo_id` renders through the
 *  repositoryIdNumber seam. */
export function toApiVariable(row: VariableRow): {
  owner_id: number;
  repo_id: number;
  name: string;
  data: string;
  description: string;
} {
  return {
    owner_id: row.ownerId,
    repo_id: repoIdNumber(row.repoId),
    name: row.name,
    data: row.data,
    description: row.description,
  };
}

// ---------------------------------------------------------------------------
// Runners — the registration/management family (models/actions/runner.go,
// routers/api/v1/shared/runners.go). Storage rides services/actions/model.ts's
// landed primitives (the control-plane store); this section adds only the
// API-layer wire mapping and the scope-guarded lookups the three /actions
// runner scopes share.
// ---------------------------------------------------------------------------

/** The runner scope pair — the same sentinel encoding as the secrets stores
 *  (the action_runners schema comment): repo rows are `{ownerId: 0, repoId}`,
 *  org/user rows `{ownerId, repoId: ""}`; `(0, "")` is global and editable in
 *  NO non-admin context (runner.go:158-169). */
export type RunnerScope = SecretScope;

/** RunnerOfflineTime (models/actions/runner.go:76). */
export const RUNNER_OFFLINE_MS = 60_000;
/** RunnerIdleTime (models/actions/runner.go:77). */
export const RUNNER_IDLE_MS = 10_000;

export type RunnerStatusName = "active" | "idle" | "offline";

/** ActionRunner.Status (runner.go:127-135): offline past RunnerOfflineTime
 *  since last_online, idle past RunnerIdleTime since last_active, else
 *  active. NULL timestamps are upstream's 0 sentinel (never seen → the epoch
 *  → offline). */
export function runnerStatusOf(row: Pick<RunnerRow, "lastOnline" | "lastActive">, now: Date): RunnerStatusName {
  const lastOnline = row.lastOnline?.getTime() ?? 0;
  const lastActive = row.lastActive?.getTime() ?? 0;
  if (now.getTime() - lastOnline > RUNNER_OFFLINE_MS) return "offline";
  if (now.getTime() - lastActive > RUNNER_IDLE_MS) return "idle";
  return "active";
}

/** The API `ActionRunner` (modules/structs/repo_actions.go:232-241) rendered
 *  by convert.ToActionRunner (services/convert/convert.go:793-814): `status`
 *  is the coarse online/offline string (NOT the statusName), `busy` mirrors
 *  the fine ACTIVE rank, and every agent label becomes an {id: index, name,
 *  type: "custom"} triple. */
export function toApiRunner(row: RunnerRow, now: Date): {
  id: number;
  name: string;
  status: "online" | "offline";
  busy: boolean;
  disabled: boolean;
  ephemeral: boolean;
  labels: Array<{ id: number; name: string; type: string }>;
} {
  const status = runnerStatusOf(row, now);
  let labels: Array<{ id: number; name: string; type: string }>;
  try {
    const parsed: unknown = JSON.parse(row.agentLabels);
    labels = Array.isArray(parsed)
      ? parsed.map((name, i) => ({ id: i, name: String(name), type: "custom" }))
      : [];
  } catch {
    labels = [];
  }
  return {
    id: row.id,
    name: row.name,
    status: status === "offline" ? "offline" : "online",
    busy: status === "active",
    disabled: row.isDisabled,
    ephemeral: row.ephemeral,
    labels,
  };
}

/** The FindRunnerOptions default order (runner.go:315) — the computed status
 *  rank first, then is_disabled, last_online desc, and the id tiebreaker.
 *  The rank CASE is runnerStatusOrderExpr (runner.go:286-292) with the NULL
 *  columns COALESCEd to upstream's 0 sentinel so never-seen runners rank
 *  offline. The thresholds ride the same instant as the API status fields so
 *  a page boundary cannot disagree with the rendered status. */
function runnerStatusOrder(now: Date) {
  const offlineThreshold = Math.floor(now.getTime() / 1000) - Math.floor(RUNNER_OFFLINE_MS / 1000);
  const idleThreshold = Math.floor(now.getTime() / 1000) - Math.floor(RUNNER_IDLE_MS / 1000);
  return sql`CASE WHEN COALESCE(${actionRunners.lastOnline}, 0) <= ${offlineThreshold} THEN 2 WHEN COALESCE(${actionRunners.lastActive}, 0) <= ${idleThreshold} THEN 1 ELSE 0 END`;
}

function runnerScopeCond(scope: RunnerScope) {
  return and(eq(actionRunners.ownerId, scope.ownerId), eq(actionRunners.repoId, scope.repoId));
}

/** shared.ListRunners (routers/api/v1/shared/runners.go:41-66): scope-filtered
 *  (WithAvailable is FALSE on the API — a repo lists only its own rows, not
 *  the owner's or global's), the optional disabled filter, upstream's default
 *  order, paginated with the total. `disabled` mirrors FormOptionalBool
 *  (services/context/base_form.go:71-79): null = absent (no filter); an
 *  unparsable value parses as false upstream, so callers map it before us. */
export async function listRunnerRows(
  d1: D1Database,
  scope: RunnerScope,
  disabled: boolean | null,
  page: number,
  limit: number,
  now: Date = new Date(),
): Promise<{ rows: RunnerRow[]; total: number }> {
  const where = disabled === null ? runnerScopeCond(scope) : and(runnerScopeCond(scope), eq(actionRunners.isDisabled, disabled));
  const totals = await drizzle(d1).select({ value: count() }).from(actionRunners).where(where);
  const rows = await drizzle(d1)
    .select()
    .from(actionRunners)
    .where(where)
    .orderBy(runnerStatusOrder(now), asc(actionRunners.isDisabled), desc(actionRunners.lastOnline), asc(actionRunners.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { rows, total: totals[0]?.value ?? 0 };
}

export type RunnerLookup =
  | { kind: "found"; row: RunnerRow }
  | { kind: "miss" }
  | { kind: "foreign" };

/** getRunnerByID + EditableInContext (shared/runners.go:68-84): the global
 *  lookup first (the miss carries the 404 wire text below), then the context
 *  guard — repo scopes match `repoId`, owner scopes match `ownerId`
 *  (runner.go:158-169); a runner belonging to a sibling scope (or global)
 *  is a "foreign" 404, indistinguishable from a miss to unauthorized eyes
 *  EXCEPT for the message ("No permission…" vs the not-exist text). */
export async function findRunnerInContext(d1: D1Database, runnerId: number, scope: RunnerScope): Promise<RunnerLookup> {
  const row = await getRunnerById(d1, runnerId);
  if (row === null) {
    return { kind: "miss" };
  }
  const inContext = scope.repoId !== "" ? row.repoId === scope.repoId : row.ownerId === scope.ownerId;
  return inContext ? { kind: "found", row } : { kind: "foreign" };
}

/** GetRunnerByID's miss through APIErrorAuto (shared/runners.go:75-77): the
 *  wrapped Error() text renders whole (util.ErrorUnwrapForUser returns
 *  err.Error(), util/error.go:43-48) — "runner with id N: resource does not
 *  exist" (runner.go:336 + util/error.go:26). */
export function runnerMissMessage(id: number): string {
  return `runner with id ${id}: resource does not exist`;
}

/** The EditableInContext 404 text (shared/runners.go:80,
 *  APIErrorNotFound("No permission to access this runner")). */
export const RUNNER_FOREIGN_MESSAGE = "No permission to access this runner";

/** SetRunnerDisabled (models/actions/runner.go:354-366): the equal-value
 *  PATCH is a no-op (no update, no version bump); a real flip updates the
 *  one column and bumps the scope's task version so polling runners re-fetch
 *  immediately. */
export async function setRunnerDisabled(d1: D1Database, row: RunnerRow, isDisabled: boolean): Promise<void> {
  if (row.isDisabled === isDisabled) {
    return;
  }
  await updateRunner(d1, row.id, { isDisabled });
  await increaseTaskVersion(d1, row.ownerId, row.repoId);
}

// ---------------------------------------------------------------------------
// Workflow runs/jobs listing — the `/actions/runs` + `/actions/jobs` pairs at
// all three scopes (P1-8, the board's slice 1: routers/api/v1/shared/
// action.go ListRuns/ListJobs, wired by addActionsRoutes'
// `m.Get("/runs", reqToken(), reqReaderCheck, act.ListWorkflowRuns)` /
// `m.Get("/jobs", …)` — api.go:992-993 at repo scope (the READER gate, not
// reqOwner), api.go:1738-1742 at org scope (reqOrgMembership), api.go:1135-1136
// at user scope (plain reqToken — the landed /user group posture). The code
// is M3-INDEPENDENT: an empty store lists empty; the rows rendered are
// whatever the insertion seams (SPEC-0012 §3) wrote. Upstream anchors,
// per-function:
//
//   - internalStatusesFromQuery — shared.convertToInternal
//                               (shared/action.go:102-130); the unknown-word
//                               arm is the InvalidArgument 400
//                               "invalid status %s" the handler emits
//                               (action.go:83-89, 186-192)
//   - resolveJobSortOrder       — utils.ResolveSortOrder (utils/sort.go:18-38)
//                               over JobOrderByMap (run_job_list.go:108-111);
//                               absent sort → the default id-ASC (order then
//                               IGNORED); order resolved BEFORE mode, so a
//                               bogus pair 422s the ORDER text; "id" is the
//                               only mode
//   - refBranchName / refPullIndex — git.RefName.BranchName / PullIndex
//                               (modules/git/ref.go:139-157)
//   - actionsStatusWords        — convert.ToActionsStatus
//                               (services/convert/convert.go:459-484); the
//                               default arm's unknown-status panic throws
//   - runActionsStatusWords     — convert.ToRunActionsStatus (convert.go:455-457:
//                               BLOCKED + NeedApproval renders "waiting")
//   - listWorkflowRunsWire      — shared.ListRuns (shared/action.go:172-243)
//                               over FindRunOptions (run_list.go:78-130);
//                               order `index DESC` repo-scoped / `id DESC`
//                               otherwise (ToOrders, run_list.go:142-153);
//                               the owner arm is upstream's INNER JOIN on
//                               repository.owner_id (ToJoins,
//                               run_list.go:132-140) — the landed
//                               action_runs.owner_id carries the same
//                               denormalized column; the orphan-drop arm
//                               (shared/action.go:222-227) shrinks the total
//   - accessibleOwnerRepoIds    — FindUserActionsAccessibleOwnerRepoIDsSubQuery
//                               (models/repo/repo_list.go:805-810): nil
//                               (unrestricted) for ownerID <= 0 — the repo
//                               scope's own gate — and for site admins
//                               (DoerIsSiteAdminFullAccess,
//                               user_extdata.go:114-120); otherwise the
//                               owner's repos the doer can view
//                               (AccessibleRepositoryCondition,
//                               repo_list.go:662-700) — the landed
//                               canViewRepository matrix + the batched team
//                               grants (viewerTeamAccessModes)
//   - toApiWorkflowRun          — convert.ToActionWorkflowRun
//                               (convert.go:276-345): the latest attempt
//                               (GetLatestAttempt via LatestAttemptID)
//                               mirrors status/started/stopped and the
//                               trigger actor, run_attempt stays 0 only for
//                               legacy pre-attempt rows, and the embedded
//                               `repository` renders through ToRepo with
//                               Permission{AccessMode: AccessModeNone}
//                               (convert.go:338) — the ZERO permission block
//                               (repository.go:41-45), doer-independent;
//   - loadPullRequestsForRun    — the convert.go:348-410 port: PR-family
//                               events take the PR the run's refs/pull/N/head
//                               points at, push takes the OPEN same-head
//                               PRs, everything else takes none; the missing
//                               PR row is the empty arm, not an error
//   - listWorkflowJobsWire      — shared.ListJobs (shared/action.go:37-100)
//                               over FindRunJobOptions (run_job_list.go);
//   - toApiWorkflowJob          — convert.toActionWorkflowJob
//                               (convert.go:540-583): head_sha/head_branch
//                               read the RUN row, runner_id/runner_name +
//                               steps ride the job's EFFECTIVE task
//                               (EffectiveTaskID, run_job.go:158-162), and
//                               the step `number` is the LOOP index
//                               (convert.go:552), not the step's column
// ---------------------------------------------------------------------------

/** shared.convertToInternal (shared/action.go:102-130) — the wire status
 *  words to the internal Status ranks; an unknown word throws the exact
 *  InvalidArgument 400 text the shared handlers render
 *  ("invalid status %s"). Accepts REPEATED params (FormStrings). */
export function internalStatusesFromQuery(words: string[]): number[] {
  const out: number[] = [];
  for (const word of words) {
    switch (word) {
      case "pending":
      case "waiting":
      case "requested":
      case "action_required":
        out.push(ACTION_STATUS_BLOCKED, ACTION_STATUS_PENDING);
        break;
      case "queued":
        out.push(ACTION_STATUS_WAITING);
        break;
      case "in_progress":
        out.push(ACTION_STATUS_RUNNING);
        break;
      case "completed":
        out.push(ACTION_STATUS_SUCCESS, ACTION_STATUS_FAILURE, ACTION_STATUS_SKIPPED, ACTION_STATUS_CANCELLED);
        break;
      case "failure":
        out.push(ACTION_STATUS_FAILURE);
        break;
      case "success":
        out.push(ACTION_STATUS_SUCCESS);
        break;
      case "skipped":
      case "neutral":
        out.push(ACTION_STATUS_SKIPPED);
        break;
      case "cancelled":
      case "timed_out":
        out.push(ACTION_STATUS_CANCELLED);
        break;
      default:
        throw new ApiError(400, `invalid status ${word}`);
    }
  }
  return out;
}

/** ResolveSortOrder over JobOrderByMap — see the module anchors. `sort`
 *  absent → the default id-ASC with `order` IGNORED; otherwise order is
 *  resolved first (a bogus pair 422s the ORDER text) and "id" is the only
 *  valid mode. Go %q renders as JSON quotes for plain ASCII words. */
export function resolveJobSortOrder(sort: string | null, order: string | null): "id ASC" | "id DESC" {
  if (sort === null || sort === "") {
    return "id ASC";
  }
  const direction = order === null || order === "" ? "asc" : order;
  if (direction !== "asc" && direction !== "desc") {
    throw new ApiError(422, `Invalid sort order: ${JSON.stringify(direction)}`);
  }
  if (sort !== "id") {
    throw new ApiError(422, `Invalid sort mode: ${JSON.stringify(sort)}`);
  }
  return direction === "asc" ? "id ASC" : "id DESC";
}

/** The shared.ListRuns prologue (shared/action.go:185-206): the query
 *  filters into WorkflowRunListFilters. Arm order is upstream's — the status
 *  words parse FIRST (the 400), then the `actor` lookup (the 404);
 *  `branch` expands to the full ref (git.RefNameFromBranch). Reads REPEATED
 *  `status` params (FormStrings). The scoped-workflow branch
 *  (workflowID != "" reads scoped_workflow_source_repo_id,
 *  shared/action.go:191-195) never fires — all three scopes pass "". */
export async function workflowRunFiltersFromQuery(
  d1: D1Database,
  url: URL,
  scope: { ownerId: number; repoId: string },
): Promise<WorkflowRunListFilters> {
  const statuses = internalStatusesFromQuery(url.searchParams.getAll("status"));
  let triggerUserId = 0;
  const actor = url.searchParams.get("actor") ?? "";
  if (actor !== "") {
    const rows = await drizzle(d1)
      .select()
      .from(users)
      .where(eq(users.usernameLower, actor.toLowerCase()))
      .limit(1);
    const user = rows[0];
    if (user === undefined) {
      throw new ApiError(404, userNotExistMessage(actor));
    }
    triggerUserId = user.id;
  }
  const branch = url.searchParams.get("branch") ?? "";
  return {
    ownerId: scope.ownerId,
    repoId: scope.repoId,
    triggerEvent: url.searchParams.get("event") ?? "",
    ref: branch === "" ? "" : `refs/heads/${branch}`,
    statuses,
    triggerUserId,
    commitSha: url.searchParams.get("head_sha") ?? "",
  };
}

/** The shared.ListJobs prologue (shared/action.go:40-66): the sort/order
 *  resolution FIRST (the 422s), then the status words (the 400). Repeated
 *  `status` params read like FormStrings. */
export function workflowJobFiltersFromQuery(url: URL): {
  statuses: number[];
  order: "id ASC" | "id DESC";
} {
  const order = resolveJobSortOrder(url.searchParams.get("sort"), url.searchParams.get("order"));
  return { statuses: internalStatusesFromQuery(url.searchParams.getAll("status")), order };
}

/** git.RefName.BranchName (modules/git/ref.go:139-141): the refs/heads/ short
 *  name; "" for every other ref shape (tags, pulls, raw SHAs). */
export function refBranchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
}

/** git.RefName.PullIndex (modules/git/ref.go:143-157): the N of
 *  refs/pull/N/head; null when the ref is not a pull ref. */
export function refPullIndex(ref: string): number | null {
  if (!ref.startsWith("refs/pull/")) {
    return null;
  }
  const rest = ref.slice("refs/pull/".length);
  const cut = rest.lastIndexOf("/");
  if (cut < 0 || rest.slice(cut + 1) !== "head") {
    return null;
  }
  const index = Number.parseInt(rest.slice(0, cut), 10);
  return Number.isInteger(index) ? index : null;
}

/** convert.ToActionsStatus (services/convert/convert.go:459-484) — the fine
 *  Status → (status, conclusion) wire words. The default arm's unknown-status
 *  PanicInDevOrTesting throws here (the error handler 500s it, the same
 *  "shouldn't happen" posture). */
function actionsStatusWords(status: number): { status: string; conclusion: string } {
  switch (status) {
    case ACTION_STATUS_WAITING:
      return { status: "queued", conclusion: "" };
    case ACTION_STATUS_BLOCKED:
      return { status: "pending", conclusion: "" };
    case ACTION_STATUS_PENDING:
      return { status: "requested", conclusion: "" };
    case ACTION_STATUS_RUNNING:
    case ACTION_STATUS_CANCELLING:
      return { status: "in_progress", conclusion: "" };
    default: {
      const conclusion =
        status === ACTION_STATUS_SUCCESS
          ? "success"
          : status === ACTION_STATUS_CANCELLED
            ? "cancelled"
            : status === ACTION_STATUS_FAILURE
              ? "failure"
              : status === ACTION_STATUS_SKIPPED
                ? "skipped"
                : null;
      if (conclusion === null) {
        throw new Error(`unknown action status: ${status}`);
      }
      return { status: "completed", conclusion };
    }
  }
}

/** convert.ToRunActionsStatus (services/convert/convert.go:455-457) — a
 *  BLOCKED row still awaiting its approval renders "waiting" with NO
 *  conclusion. */
function runActionsStatusWords(run: Pick<RunRow, "needApproval">, status: number): { status: string; conclusion: string } {
  if (status === ACTION_STATUS_BLOCKED && run.needApproval) {
    return { status: "waiting", conclusion: "" };
  }
  return actionsStatusWords(status);
}

/** TimeStamp.AsLocalTime's JSON render for the ZERO timestamp — a NULL
 *  started/stopped renders Go's zero time (the landed GO_ZERO_TIME
 *  convention, services/repository.ts). */
function actionTimeIso(value: Date | null): string {
  return value === null ? GO_ZERO_TIME : value.toISOString();
}

/** ErrUserNotExist's Error() for the `actor` filter's GetUserByName miss
 *  (models/user/error.go:45-49; GetUserByName constructs UID 0). */
export function userNotExistMessage(name: string): string {
  return `user does not exist [uid: 0, name: ${name}]`;
}

// ---------------------------------------------------------------------------
// The accessible-repos arm (the org/user scopes' row filter).
// ---------------------------------------------------------------------------

/**
 * FindUserActionsAccessibleOwnerRepoIDsSubQuery (models/repo/repo_list.go:805-810)
 * materialized to an id list: null = unrestricted (ownerID <= 0 — the repo
 * scope checks its one repo at the gate — and site admins,
 * DoerIsSiteAdminFullAccess); otherwise the owner's repos the doer can view,
 * the landed canViewRepository matrix + the batched team grants standing in
 * for AccessibleRepositoryCondition (repo_list.go:662-700). An owner with no
 * repos (or no accessible ones) yields [] — everything filters away.
 */
export async function accessibleOwnerRepoIds(d1: D1Database, ownerId: number, viewer: Viewer): Promise<string[] | null> {
  if (ownerId <= 0 || viewer.requester?.is_admin === true) {
    return null;
  }
  const rows = await drizzle(d1).select().from(repositories).where(eq(repositories.ownerId, ownerId)).all();
  if (rows.length === 0) {
    return [];
  }
  const teamModes = await viewerTeamAccessModes(d1, viewer, rows);
  return rows
    .filter((repo) => canViewRepository(viewer, repo, teamModes.get(repo.id) ?? null))
    .map((repo) => repo.id);
}

// ---------------------------------------------------------------------------
// The runs listing (shared.ListRuns).
// ---------------------------------------------------------------------------

export interface WorkflowRunListFilters {
  /** The owner-scope arm (org/user); 0 = unset. */
  ownerId: number;
  /** The repo-scope arm; "" = unset. Never both set — shared.ListRuns's own
   *  PanicInDevOrTesting guard (shared/action.go:176-178). */
  repoId: string;
  /** The `event` filter ("" = no filter); a plain equality on
   *  trigger_event — upstream's webhook.HookEventType(event) is a cast. */
  triggerEvent: string;
  /** The `branch` filter pre-expanded to the full ref ("" = none). */
  ref: string;
  /** The `status` filters, internalStatusesFromQuery's output. */
  statuses: number[];
  /** The `actor` filter's resolved user id; 0 = no filter. */
  triggerUserId: number;
  /** The `head_sha` filter ("" = none). */
  commitSha: string;
}

/** The `ActionWorkflowRun` wire (modules/structs/repo_actions.go:110-157) —
 *  omitempty fields are optional; `previous_attempt_url` is deliberately
 *  non-optional (the null renders, convert.go:300-307). */
export interface ActionWorkflowRunWire {
  id: number;
  url: string;
  previous_attempt_url: string | null;
  html_url: string;
  jobs_url: string;
  logs_url: string;
  artifacts_url: string;
  cancel_url: string;
  rerun_url: string;
  display_title: string;
  path: string;
  event: string;
  run_attempt: number;
  run_number: number;
  head_sha: string;
  head_branch?: string;
  status: string;
  conclusion?: string;
  actor?: ReturnType<typeof toApiUser>;
  trigger_actor?: ReturnType<typeof toApiUser>;
  repository?: ReturnType<typeof toApiRepository>;
  pull_requests: Array<{
    id: number;
    number: number;
    url: string;
    head: { ref: string; sha: string; repo: { id: number; url: string; name: string } };
    base: { ref: string; sha: string; repo: { id: number; url: string; name: string } };
  }>;
  created_at: string;
  updated_at: string;
  started_at: string;
  completed_at: string;
}

export interface WorkflowRunsPage {
  totalCount: number;
  runs: ActionWorkflowRunWire[];
}

/** Users-row batch (the page's trigger users) — the users.id IN read. */
async function userRowsByIds(d1: D1Database, ids: number[]): Promise<Map<number, UserRow>> {
  const byId = new Map<number, UserRow>();
  if (ids.length === 0) {
    return byId;
  }
  const rows = await drizzle(d1).select().from(users).where(inArray(users.id, ids)).all();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return byId;
}

/** The page's latest attempts, keyed by ATTEMPT id (the run rows'
 *  latest_attempt_id pointers). */
async function runAttemptsByIds(d1: D1Database, ids: number[]): Promise<Map<number, RunAttemptRow>> {
  const byId = new Map<number, RunAttemptRow>();
  if (ids.length === 0) {
    return byId;
  }
  const rows = await drizzle(d1).select().from(actionRunAttempts).where(inArray(actionRunAttempts.id, ids)).all();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return byId;
}

/** Users-row lookup by id (the attempt trigger actor's per-row arm). */
async function userRowById(d1: D1Database, id: number): Promise<UserRow | null> {
  const rows = await drizzle(d1).select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** The PR-family event words whose runs take the ref-pointed PR
 *  (HookEventType.IsPullRequest/IsPullRequestReview,
 *  modules/webhook/type.go:71-95 over the Event() mapping at :38-53 and the
 *  constants at :20-29). */
const PR_REF_EVENTS = new Set([
  "pull_request",
  "pull_request_assign",
  "pull_request_label",
  "pull_request_milestone",
  "pull_request_sync",
  "pull_request_review_request",
  "pull_request_review_approved",
  "pull_request_review_rejected",
  "pull_request_review_comment",
]);

/** toPullRequestMinimal (convert.go:392-428) — the `pull_requests` entry.
 *  `sha` on the HEAD side is the RUN's commit sha (the caller passes it),
 *  the BASE side carries the PR's merge base (null → Go's empty string),
 *  and the head repo falls back to the base pair when the head row is gone
 *  (LoadHeadRepo's nil arm, convert.go:397-401). */
function pullRequestMinimal(
  viewer: Viewer,
  basePair: RepositoryWithOwner,
  headPair: RepositoryWithOwner | null,
  pr: PullRequestRow,
  headSha: string,
): ActionWorkflowRunWire["pull_requests"][number] {
  const repoApiUrl = (pair: RepositoryWithOwner): string =>
    `${viewer.origin}/api/v1/repos/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const head = headPair ?? basePair;
  return {
    id: pr.id,
    number: pr.index,
    url: `${repoApiUrl(basePair)}/pulls/${pr.index}`,
    head: {
      ref: pr.headBranch,
      sha: headSha,
      repo: { id: repoIdNumber(head.repo.id), url: repoApiUrl(head), name: head.repo.slug },
    },
    base: {
      ref: pr.baseBranch,
      sha: pr.mergeBase ?? "",
      repo: { id: repoIdNumber(basePair.repo.id), url: repoApiUrl(basePair), name: basePair.repo.slug },
    },
  };
}

/** loadPullRequestsForRun (convert.go:348-390): PR-family events resolve the
 *  run's refs/pull/N/head PR; push events take the OPEN PRs whose head
 *  branch matches the pushed ref in the same repo
 *  (GetUnmergedPullRequestsByHeadInfo, models/issues/pull_list.go:64-70:
 *  head_repo_id + head_branch + not merged + issue open + github flow);
 *  every other event takes none. A missing PR row is the empty arm
 *  (IsErrPullRequestNotExist), not an error. */
async function loadPullRequestsForRun(
  d1: D1Database,
  viewer: Viewer,
  run: RunRow,
  pair: RepositoryWithOwner,
): Promise<ActionWorkflowRunWire["pull_requests"]> {
  let prRows: PullRequestRow[];
  if (PR_REF_EVENTS.has(run.event)) {
    const index = refPullIndex(run.ref);
    if (index === null) {
      return [];
    }
    const rows = await drizzle(d1)
      .select({ pr: pullRequests })
      .from(pullRequests)
      .where(and(eq(pullRequests.baseRepoId, run.repoId), eq(pullRequests.index, index)))
      .limit(1);
    if (rows[0] === undefined) {
      return [];
    }
    prRows = [rows[0].pr];
  } else if (run.event === "push") {
    const branch = refBranchName(run.ref);
    if (branch === "") {
      return [];
    }
    prRows = await drizzle(d1)
      .select({ pr: pullRequests })
      .from(pullRequests)
      .innerJoin(issues, eq(issues.id, pullRequests.issueId))
      .where(
        and(
          eq(pullRequests.headRepoId, run.repoId),
          eq(pullRequests.headBranch, branch),
          eq(pullRequests.hasMerged, false),
          eq(pullRequests.flow, PRFlow.Github),
          eq(issues.isClosed, false),
        ),
      )
      .all()
      .then((rows) => rows.map((row) => row.pr));
  } else {
    return [];
  }
  if (prRows.length === 0) {
    return [];
  }
  const headRepos = await findRepositoriesByIds(
    d1,
    [...new Set(prRows.map((pr) => pr.headRepoId).filter((id) => id !== pair.repo.id))],
  );
  return prRows.map((pr) => {
    const sameRepo = pr.headRepoId === pair.repo.id;
    const headPair = sameRepo ? pair : (headRepos.get(pr.headRepoId) ?? null);
    return pullRequestMinimal(viewer, pair, headPair, pr, run.commitSha);
  });
}

/** convert.ToActionWorkflowRun (services/convert/convert.go:276-345) — see
 *  the module anchors. The latest attempt mirrors status/started/stopped and
 *  the trigger actor; the embedded repository renders with the ZERO
 *  permission block (ToRepo with AccessModeNone — doer-independent). */
async function toApiWorkflowRun(
  d1: D1Database,
  viewer: Viewer,
  run: RunRow,
  deps: {
    pair: RepositoryWithOwner;
    triggerUser: UserRow | null;
    latestAttempt: RunAttemptRow | null;
    excludePullRequests: boolean;
  },
): Promise<ActionWorkflowRunWire> {
  const ownerNamespace = encodeURIComponent(deps.pair.repo.ownerNamespace);
  const slug = encodeURIComponent(deps.pair.repo.slug);
  const repoApiUrl = `${viewer.origin}/api/v1/repos/${ownerNamespace}/${slug}`;
  const repoHtmlUrl = `${viewer.origin}/${ownerNamespace}/${slug}`;
  const runUrl = `${repoApiUrl}/actions/runs/${run.id}`;
  const attempt = deps.latestAttempt;
  const words = runActionsStatusWords(run, attempt?.status ?? run.status);
  const startedAt = attempt?.started ?? run.started;
  const completedAt = attempt?.stopped ?? run.stopped;
  const triggerUserId = attempt !== null && attempt.triggerUserId !== 0 ? attempt.triggerUserId : run.triggerUserId;
  const triggerActorRow = triggerUserId === run.triggerUserId ? deps.triggerUser : (triggerUserId === 0 ? null : await userRowById(d1, triggerUserId));
  const headBranch = refBranchName(run.ref);
  const previousAttemptUrl = attempt !== null && attempt.attempt > 1 ? `${runUrl}/attempts/${attempt.attempt - 1}` : null;
  const pullRequests = deps.excludePullRequests
    ? []
    : await loadPullRequestsForRun(d1, viewer, run, deps.pair);
  return {
    id: run.id,
    url: runUrl,
    previous_attempt_url: previousAttemptUrl,
    html_url: `${repoHtmlUrl}/actions/runs/${run.id}`,
    jobs_url: `${runUrl}/jobs`,
    logs_url: `${runUrl}/logs`,
    artifacts_url: `${runUrl}/artifacts`,
    cancel_url: `${runUrl}/cancel`,
    rerun_url: `${runUrl}/rerun`,
    display_title: run.title,
    path: `${run.workflowId}@${run.ref}`,
    event: run.triggerEvent,
    run_attempt: attempt?.attempt ?? 0,
    run_number: run.index,
    head_sha: run.commitSha,
    ...(headBranch !== "" ? { head_branch: headBranch } : {}),
    status: words.status,
    ...(words.conclusion !== "" ? { conclusion: words.conclusion } : {}),
    ...(deps.triggerUser !== null ? { actor: toApiUser(viewer, deps.triggerUser) } : {}),
    ...(triggerActorRow !== null ? { trigger_actor: toApiUser(viewer, triggerActorRow) } : {}),
    repository: {
      // ToRepo with Permission{AccessMode: AccessModeNone} (convert.go:338):
      // the permission block reads the PASSED permission, not the doer's
      // (repository.go:41-45) — the zero block on every render.
      ...toApiRepository(viewer, deps.pair),
      permissions: { admin: false, push: false, pull: false },
    },
    pull_requests: pullRequests,
    created_at: actionTimeIso(run.created),
    updated_at: actionTimeIso(run.updated),
    started_at: actionTimeIso(startedAt),
    completed_at: actionTimeIso(completedAt),
  };
}

/** shared.ListRuns (routers/api/v1/shared/action.go:172-243) — the filtered,
 *  paginated run page rendered to the wire; the orphan rows (no joined repo)
 *  drop and shrink the total (shared/action.go:222-227). */
export async function listWorkflowRunsWire(
  d1: D1Database,
  viewer: Viewer,
  filters: WorkflowRunListFilters,
  page: number,
  limit: number,
  excludePullRequests: boolean,
  accessibleRepoIds: string[] | null,
): Promise<WorkflowRunsPage> {
  if (filters.ownerId !== 0 && filters.repoId !== "") {
    throw new Error("actions: owner and repo filters are mutually exclusive");
  }
  const conds = [];
  if (filters.repoId !== "") {
    conds.push(eq(actionRuns.repoId, filters.repoId));
  }
  if (filters.ownerId !== 0) {
    conds.push(eq(actionRuns.ownerId, filters.ownerId));
  }
  if (filters.triggerEvent !== "") {
    conds.push(eq(actionRuns.triggerEvent, filters.triggerEvent));
  }
  if (filters.ref !== "") {
    conds.push(eq(actionRuns.ref, filters.ref));
  }
  if (filters.statuses.length > 0) {
    conds.push(inArray(actionRuns.status, filters.statuses));
  }
  if (filters.triggerUserId !== 0) {
    conds.push(eq(actionRuns.triggerUserId, filters.triggerUserId));
  }
  if (filters.commitSha !== "") {
    conds.push(eq(actionRuns.commitSha, filters.commitSha));
  }
  if (accessibleRepoIds !== null) {
    if (accessibleRepoIds.length === 0) {
      return { totalCount: 0, runs: [] };
    }
    conds.push(inArray(actionRuns.repoId, accessibleRepoIds));
  }
  const where = conds.length > 0 ? and(...conds) : undefined;
  // ToOrders (run_list.go:142-153): the per-repo run number orders the
  // repo-scoped page; the global id orders owner-scoped pages.
  const order = filters.repoId !== "" ? [desc(actionRuns.index)] : [desc(actionRuns.id)];
  const totals = await drizzle(d1).select({ value: count() }).from(actionRuns).where(where);
  const rows = await drizzle(d1)
    .select()
    .from(actionRuns)
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset((page - 1) * limit);
  let total = totals[0]?.value ?? 0;
  const [repos, triggerUsers, attempts] = await Promise.all([
    findRepositoriesByIds(d1, [...new Set(rows.map((r) => r.repoId))]),
    userRowsByIds(d1, [...new Set(rows.map((r) => r.triggerUserId).filter((id) => id !== 0))]),
    runAttemptsByIds(d1, [...new Set(rows.map((r) => r.latestAttemptId).filter((id) => id !== 0))]),
  ]);
  const runs: ActionWorkflowRunWire[] = [];
  for (const row of rows) {
    const pair = repos.get(row.repoId);
    if (pair === undefined) {
      total--;
      continue;
    }
    runs.push(
      await toApiWorkflowRun(d1, viewer, row, {
        pair,
        triggerUser: row.triggerUserId === 0 ? null : (triggerUsers.get(row.triggerUserId) ?? null),
        latestAttempt: attempts.get(row.latestAttemptId) ?? null,
        excludePullRequests,
      }),
    );
  }
  return { totalCount: total, runs };
}

// ---------------------------------------------------------------------------
// The jobs listing (shared.ListJobs).
// ---------------------------------------------------------------------------

export interface WorkflowJobListFilters {
  ownerId: number;
  repoId: string;
  statuses: number[];
}

/** The `ActionWorkflowJob` wire (modules/structs/repo_actions.go:190-215) —
 *  omitempty fields are optional. */
export interface ActionWorkflowJobWire {
  id: number;
  url: string;
  html_url: string;
  run_id: number;
  run_url: string;
  name: string;
  labels: string[];
  run_attempt: number;
  head_sha: string;
  head_branch?: string;
  status: string;
  conclusion?: string;
  runner_id?: number;
  runner_name?: string;
  steps: Array<{
    name: string;
    number: number;
    status: string;
    conclusion?: string;
    started_at: string;
    completed_at: string;
  }>;
  created_at: string;
  started_at: string;
  completed_at: string;
}

export interface WorkflowJobsPage {
  totalCount: number;
  jobs: ActionWorkflowJobWire[];
}

/** ActionRunJob.EffectiveTaskID (models/actions/run_job.go:158-162) — the
 *  current task, else the historical one a rerun reuses. */
function effectiveTaskId(job: RunJobRow): number {
  return job.taskId > 0 ? job.taskId : job.sourceTaskId;
}

function parseRunsOn(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((label) => String(label)) : [];
  } catch {
    return [];
  }
}

/** convert.toActionWorkflowJob (services/convert/convert.go:540-583) — see
 *  the module anchors: head_sha/head_branch read the RUN row, the runner and
 *  steps ride the job's EFFECTIVE task, and the step `number` is the loop
 *  index (convert.go:552). */
function toApiWorkflowJob(
  viewer: Viewer,
  job: RunJobRow,
  run: RunRow,
  pair: RepositoryWithOwner,
  deps: { task: { id: number; runnerId: number } | null; steps: Array<{ name: string; status: number; started: Date | null; stopped: Date | null }>; runnerName: string },
): ActionWorkflowJobWire {
  const ownerNamespace = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const repoApiUrl = `${viewer.origin}/api/v1/repos/${ownerNamespace}/${slug}`;
  const repoHtmlUrl = `${viewer.origin}/${ownerNamespace}/${slug}`;
  const words = runActionsStatusWords(run, job.status);
  const headBranch = refBranchName(run.ref);
  const hasTask = deps.task !== null && effectiveTaskId(job) !== 0;
  const runnerId = hasTask && deps.task !== null ? deps.task.runnerId : 0;
  const runnerName = hasTask ? deps.runnerName : "";
  const steps = hasTask
    ? deps.steps.map((step, i) => {
        const stepWords = actionsStatusWords(step.status);
        return {
          name: step.name,
          number: i,
          status: stepWords.status,
          ...(stepWords.conclusion !== "" ? { conclusion: stepWords.conclusion } : {}),
          started_at: actionTimeIso(step.started),
          completed_at: actionTimeIso(step.stopped),
        };
      })
    : [];
  return {
    id: job.id,
    url: `${repoApiUrl}/actions/jobs/${job.id}`,
    html_url: `${repoHtmlUrl}/actions/runs/${job.runId}/jobs/${job.id}`,
    run_id: job.runId,
    run_url: `${repoApiUrl}/actions/runs/${job.runId}`,
    name: job.name,
    labels: parseRunsOn(job.runsOn),
    run_attempt: job.attempt,
    head_sha: run.commitSha,
    ...(headBranch !== "" ? { head_branch: headBranch } : {}),
    status: words.status,
    ...(words.conclusion !== "" ? { conclusion: words.conclusion } : {}),
    ...(runnerId !== 0 ? { runner_id: runnerId } : {}),
    ...(runnerName !== "" ? { runner_name: runnerName } : {}),
    steps,
    created_at: actionTimeIso(job.created),
    started_at: actionTimeIso(job.started),
    completed_at: actionTimeIso(job.stopped),
  };
}

/** shared.ListJobs (routers/api/v1/shared/action.go:37-100) — the filtered,
 *  paginated job page rendered to the wire. `order` is
 *  resolveJobSortOrder's output ("id ASC" default). The run join is a
 *  hard dependency: upstream 500s a job whose run is missing
 *  (shared/action.go:77-82) and ours throws the same class. */
export async function listWorkflowJobsWire(
  d1: D1Database,
  viewer: Viewer,
  filters: WorkflowJobListFilters,
  order: "id ASC" | "id DESC",
  page: number,
  limit: number,
  accessibleRepoIds: string[] | null,
): Promise<WorkflowJobsPage> {
  if (filters.ownerId !== 0 && filters.repoId !== "") {
    throw new Error("actions: owner and repo filters are mutually exclusive");
  }
  const conds = [];
  if (filters.repoId !== "") {
    conds.push(eq(actionRunJobs.repoId, filters.repoId));
  }
  if (filters.ownerId !== 0) {
    conds.push(eq(actionRunJobs.ownerId, filters.ownerId));
  }
  if (filters.statuses.length > 0) {
    conds.push(inArray(actionRunJobs.status, filters.statuses));
  }
  if (accessibleRepoIds !== null) {
    if (accessibleRepoIds.length === 0) {
      return { totalCount: 0, jobs: [] };
    }
    conds.push(inArray(actionRunJobs.repoId, accessibleRepoIds));
  }
  const where = conds.length > 0 ? and(...conds) : undefined;
  const totals = await drizzle(d1).select({ value: count() }).from(actionRunJobs).where(where);
  const rows = await drizzle(d1)
    .select()
    .from(actionRunJobs)
    .where(where)
    .orderBy(order === "id ASC" ? asc(actionRunJobs.id) : desc(actionRunJobs.id))
    .limit(limit)
    .offset((page - 1) * limit);
  // No orphan-drop arm here — upstream 500s a job whose run/repo is missing
  // (shared/action.go:77-82), it never shrinks the page.
  const total = totals[0]?.value ?? 0;
  const runIds = [...new Set(rows.map((j) => j.runId))];
  const runRows =
    runIds.length > 0 ? await drizzle(d1).select().from(actionRuns).where(inArray(actionRuns.id, runIds)).all() : [];
  const runsById = new Map(runRows.map((run) => [run.id, run]));
  const taskIds = [...new Set(rows.map(effectiveTaskId).filter((id) => id !== 0))];
  const taskRows =
    taskIds.length > 0 ? await drizzle(d1).select().from(actionTasks).where(inArray(actionTasks.id, taskIds)).all() : [];
  const tasksById = new Map(taskRows.map((task) => [task.id, task]));
  const stepRows =
    taskIds.length > 0
      ? await drizzle(d1)
          .select()
          .from(actionTaskSteps)
          .where(inArray(actionTaskSteps.taskId, taskIds))
          .orderBy(asc(actionTaskSteps.index))
          .all()
      : [];
  const stepsByTask = new Map<number, Array<{ name: string; status: number; started: Date | null; stopped: Date | null }>>();
  for (const step of stepRows) {
    const list = stepsByTask.get(step.taskId) ?? [];
    list.push({ name: step.name, status: step.status, started: step.started, stopped: step.stopped });
    stepsByTask.set(step.taskId, list);
  }
  const runnerIds = [...new Set(taskRows.map((task) => task.runnerId).filter((id) => id !== 0))];
  const runnerRows =
    runnerIds.length > 0 ? await drizzle(d1).select().from(actionRunners).where(inArray(actionRunners.id, runnerIds)).all() : [];
  const runnerNamesById = new Map(runnerRows.map((runner) => [runner.id, runner.name]));
  const repos = await findRepositoriesByIds(d1, [...new Set(rows.map((j) => j.repoId))]);
  const jobs: ActionWorkflowJobWire[] = [];
  for (const row of rows) {
    const run = runsById.get(row.runId);
    const pair = repos.get(row.repoId);
    // The hard run/repo dependency (shared/action.go:77-82's
    // APIErrorInternal arm) — a row missing either is the 500 class.
    if (run === undefined || pair === undefined) {
      throw new Error(`job ${row.id} is missing its run or repository`);
    }
    const task = tasksById.get(effectiveTaskId(row)) ?? null;
    jobs.push(
      toApiWorkflowJob(viewer, row, run, pair, {
        task: task !== null ? { id: task.id, runnerId: task.runnerId } : null,
        steps: task !== null ? (stepsByTask.get(task.id) ?? []) : [],
        runnerName: task !== null ? (runnerNamesById.get(task.runnerId) ?? "") : "",
      }),
    );
  }
  return { totalCount: total, jobs };
}
