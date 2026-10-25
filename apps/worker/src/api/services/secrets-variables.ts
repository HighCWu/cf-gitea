import { and, asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionVariables, secrets } from "../../db/schema";
import { ApiError } from "../errors";

/**
 * The actions secrets/variables service — the upstream `secret` +
 * `action_variable` stores behind the three `/actions` scopes (the inventory
 * batch `wave-api-secrets-variables`, 23 operations). Upstream anchors,
 * per-function:
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
