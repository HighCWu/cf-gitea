import { and, asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { deployKeys, publicKeys, users } from "../../db/schema";
import { DEPLOY_KEY_USER_ID } from "../../services/branch-protection";
import { SshKeyParseError, parseSshPublicKey as parseSshPublicKeyDetail } from "../../services/ssh-gpg-keys";
import type { ParsedSshKey } from "../../services/ssh-gpg-keys";
import { ApiError } from "../errors";
import type { Repository } from "../models/repository";
import { apiRepositoryUrl, toApiRepository, type RepositoryWithOwner, type Viewer } from "./repository";

/**
 * The deploy-key family service — the upstream `deploykey` model port behind
 * the repo-scoped `/repos/{owner}/{repo}/keys` routes (routers/api/v1/repo/
 * key.go). Upstream anchors, per-function in the doc comments:
 *
 *   - findOrAddDeployPublicKey   — asymkey.FindOrAddDeployPublicKey
 *                                  (models/asymkey/ssh_key.go:93-120)
 *   - addDeployKeySsh            — deploykey.AddDeployKeySSH
 *                                  (models/deploykey/deploykey_ssh.go:18-44)
 *   - addDeployKeyToken          — deploykey.AddDeployKeyToken +
 *                                  generateToken (deploykey_token.go:12-44)
 *   - listDeployKeys             — ListDeployKeysOptions (deploykey.go:77-96)
 *   - getDeployKeyRow            — GetDeployKeyByID (deploykey_ssh.go:50-60)
 *   - deleteDeployKeyRow         — asymkey.DeleteDeployKey +
 *                                  deleteDeployKeyFromDB
 *                                  (services/asymkey/deploy_key.go:26-85)
 *   - toApiDeployKey             — convert.ToDeployKey (convert.go:908-925)
 *   - canSeePrivateDeployKey     — the key.go appendPrivateInformation gate
 *                                  (repo/key.go:26-38)
 *
 * THE OWNER-ID ADAPTATION — upstream stores deploy public-key rows with
 * `owner_id = 0` (no owner; FindOrAddDeployPublicKey never sets it), which
 * the landed `public_keys.owner_id → users.id` FK cannot hold. cf-gitea
 * points them at upstream's system principal `gitea:deploy-key`
 * (user_system.go:76, DeployKeyUserID = -3 — the same constant
 * branch-protection's whitelist pseudo-id uses), seeded by migration 0020
 * and re-asserted here on demand, so wiped databases (tests) satisfy the FK.
 * The row keeps `type=2`/`mode=0`/`name="(DeployKey)"`, so it stays invisible
 * to every owner-scoped key listing exactly like upstream's ownerless row.
 *
 * THE PARSER SEAM — the SSH wire-shape validation reuses the landed
 * public_keys parser, now consolidated into services/ssh-gpg-keys.ts (the
 * provable OpenSSH single-line subset; misc-t3.ts and
 * user-settings-keys.tsx import the same home — this module's former
 * verbatim copy was the admin-org-extras.ts "documented seam until a
 * consolidation wave" pattern, and that wave collapsed all three copies).
 * The shared parser throws the detail-only SshKeyParseError; the single
 * mapping below is this module's whole residue of the copy — the wired 422
 * (HandleCheckKeyStringError's "Invalid key content: …" family) that
 * misc-t3.test.ts and this module's suite pin.
 */

// ---------------------------------------------------------------------------
// The parser seam — now the shared home (services/ssh-gpg-keys.ts); this
// module keeps only the API 422 mapping (the module header note).
// ---------------------------------------------------------------------------

/** parseSshPublicKey with HandleCheckKeyStringError's route mapping: the
 *  shared parser throws the detail-only SshKeyParseError; the wired 422
 *  body prefixes "Invalid key content: ". */
async function parseSshPublicKey(raw: string): Promise<ParsedSshKey> {
  try {
    return await parseSshPublicKeyDetail(raw);
  } catch (error) {
    if (error instanceof SshKeyParseError) {
      throw new ApiError(422, `Invalid key content: ${error.message}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The upstream model ports.
// ---------------------------------------------------------------------------

export type DeployKeyRow = typeof deployKeys.$inferSelect;

/** The system principal's username (user_system.go:76 newSystemUser name). */
const DEPLOY_KEY_SYSTEM_USERNAME = "gitea:deploy-key";

/**
 * The FK backstop for the owner-id adaptation (module header): re-assert the
 * seeded `gitea:deploy-key` row, so a wiped database (tests) still satisfies
 * `public_keys.owner_id → users.id`. INSERT OR IGNORE — the username_lower
 * UNIQUE and the explicit id PK both conflict-noop on the seeded row.
 */
async function ensureDeployKeySystemUser(d1: D1Database): Promise<void> {
  await drizzle(d1)
    .insert(users)
    .values({
      id: DEPLOY_KEY_USER_ID,
      username: DEPLOY_KEY_SYSTEM_USERNAME,
      usernameLower: DEPLOY_KEY_SYSTEM_USERNAME,
      isAdmin: false,
      status: "prohibited",
      createdAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * FindOrAddDeployPublicKey (ssh_key.go:93-120): the shared `public_keys` row
 * keyed by fingerprint. An existing NON-deploy row is upstream's
 * ErrKeyAlreadyExist (HandleAddKeyError's "Key content has been used as
 * non-deploy key" 422); a deploy row is reused as-is; otherwise a fresh
 * `type=2` row materializes under the system principal with `mode=0`
 * (AccessModeNone) and the sentinel name "(DeployKey)".
 */
async function findOrAddDeployPublicKey(d1: D1Database, parsed: ParsedSshKey): Promise<typeof publicKeys.$inferSelect> {
  const db = drizzle(d1);
  const existing = await db.select().from(publicKeys).where(eq(publicKeys.fingerprint, parsed.fingerprint)).limit(1);
  if (existing.length > 0) {
    const pkey = existing[0]!;
    if (pkey.type !== 2) {
      throw new ApiError(422, "Key content has been used as non-deploy key");
    }
    return pkey;
  }
  await ensureDeployKeySystemUser(d1);
  const now = new Date();
  const inserted = await db
    .insert(publicKeys)
    .values({
      ownerId: DEPLOY_KEY_USER_ID,
      name: "(DeployKey)",
      fingerprint: parsed.fingerprint,
      content: parsed.content,
      mode: 0,
      type: 2,
      loginSourceId: 0,
      verified: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted[0]!;
}

/** checkDeployKeyName (deploykey.go:55-69) — the per-repo name collision. */
async function checkDeployKeyName(d1: D1Database, repoId: string, name: string): Promise<void> {
  const rows = await drizzle(d1)
    .select({ id: deployKeys.id })
    .from(deployKeys)
    .where(and(eq(deployKeys.repoId, repoId), eq(deployKeys.name, name)))
    .limit(1);
  if (rows.length > 0) {
    throw new ApiError(422, "A key with the same name already exists");
  }
}

/** util.CryptoRandomString — 256 bits over the 62 alphanumerics, rejection
 *  sampling so the modulo stays unbiased. */
function cryptoRandomString(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const max = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - out.length));
    for (const byte of bytes) {
      if (byte >= max) {
        continue;
      }
      out += alphabet[byte % alphabet.length];
      if (out.length === length) {
        break;
      }
    }
  }
  return out;
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Upstream AddDeployKeySSH result: the deploy row plus the shared public
 *  key's stored content (ToDeployKey renders it as `key`). */
export interface AddedDeployKey {
  row: DeployKeyRow;
  /** The plaintext token, only set for token creates (Token is xorm:"-"). */
  token?: string;
  /** The shared public key content, only set for ssh creates. */
  keyContent?: string;
}

/**
 * AddDeployKeySSH (deploykey_ssh.go:18-44): parse (HandleCheckKeyStringError's
 * 422 family), find-or-add the shared public key, then the two code checks in
 * upstream's order — (repo, key) already added ("This key has already been
 * added to this repository"), then the name ("A key with the same name
 * already exists"). `readOnly` maps read(1)/write(2); the invalid-mode guard
 * (:22-24) is unreachable from the API form's boolean.
 */
export async function addDeployKeySsh(d1: D1Database, repoId: string, title: string, key: string, readOnly: boolean): Promise<AddedDeployKey> {
  const parsed = await parseSshPublicKey(key);
  const pkey = await findOrAddDeployPublicKey(d1, parsed);
  const duplicate = await drizzle(d1)
    .select({ id: deployKeys.id })
    .from(deployKeys)
    .where(and(eq(deployKeys.repoId, repoId), eq(deployKeys.keyId, pkey.id)))
    .limit(1);
  if (duplicate.length > 0) {
    throw new ApiError(422, "This key has already been added to this repository");
  }
  await checkDeployKeyName(d1, repoId, title);
  const now = new Date();
  const inserted = await drizzle(d1)
    .insert(deployKeys)
    .values({
      keyId: pkey.id,
      repoId,
      name: title,
      keyType: 1,
      fingerprint: pkey.fingerprint,
      tokenHash: "",
      mode: readOnly ? 1 : 2,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { row: inserted[0]!, keyContent: pkey.content };
}

/**
 * AddDeployKeyToken (deploykey_token.go:12-44): generate `gdt_` + 43
 * alphanumerics (256 bits), hash it (sha256 needs no salt), mask the
 * fingerprint as `gdt_xx********yy` scan bait, then the name check. The
 * plaintext rides ONLY the returned struct — the row keeps the hash.
 */
export async function addDeployKeyToken(d1: D1Database, repoId: string, title: string, readOnly: boolean): Promise<AddedDeployKey> {
  const token = `gdt_${cryptoRandomString(43)}`;
  const tokenHash = await sha256Hex(token);
  const fingerprint = `${token.slice(0, 6)}********${token.slice(-2)}`;
  await checkDeployKeyName(d1, repoId, title);
  const now = new Date();
  const inserted = await drizzle(d1)
    .insert(deployKeys)
    .values({
      keyId: 0,
      repoId,
      name: title,
      keyType: 2,
      fingerprint,
      tokenHash,
      mode: readOnly ? 1 : 2,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { row: inserted[0]!, token };
}

/** GetDeployKeyByID (deploykey_ssh.go:50-60) — repo-scoped by construction. */
export async function getDeployKeyRow(d1: D1Database, repoId: string, id: number): Promise<DeployKeyRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(deployKeys)
    .where(and(eq(deployKeys.id, id), eq(deployKeys.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/** ErrDeployKeyNotExist.Error() (models/deploykey/error.go:27-29) — KeyID
 *  stays 0: GetDeployKeyByID's miss carries {ID, 0, RepoID}. */
export function deployKeyNotExistMessage(id: number, repoId: string): string {
  return `Deploy key does not exist [id: ${id}, key_id: 0, repo_id: ${repoId}]`;
}

/** ListDeployKeysOptions.ToConds (deploykey.go:89-96): repo_id always; key_id
 *  (0 = unfiltered) and fingerprint ("") only when set. ToOrders → `name`. */
export async function listDeployKeys(
  d1: D1Database,
  repoId: string,
  filters: { keyId: number; fingerprint: string },
  page: number,
  limit: number,
): Promise<{ rows: DeployKeyRow[]; total: number }> {
  const arms = [eq(deployKeys.repoId, repoId)];
  if (filters.keyId !== 0) {
    arms.push(eq(deployKeys.keyId, filters.keyId));
  }
  if (filters.fingerprint !== "") {
    arms.push(eq(deployKeys.fingerprint, filters.fingerprint));
  }
  const where = and(...arms);
  const rows = await drizzle(d1)
    .select()
    .from(deployKeys)
    .where(where)
    .orderBy(asc(deployKeys.name))
    .limit(limit)
    .offset((page - 1) * limit);
  const totals = await drizzle(d1).select({ n: count() }).from(deployKeys).where(where);
  return { rows, total: totals[0]?.n ?? 0 };
}

/**
 * deleteDeployKeyFromDB (services/asymkey/deploy_key.go:44-62): the deploy
 * row goes first; an ssh row's shared public key is deleted with it ONLY
 * when this was the last referencing deploy key
 * (IsDeployKeyExistByPublicKeyID) — token rows have no public key to clean
 * up. Returns the deleted row for the audit arm.
 */
export async function deleteDeployKeyRow(d1: D1Database, row: DeployKeyRow): Promise<void> {
  const db = drizzle(d1);
  await db.delete(deployKeys).where(eq(deployKeys.id, row.id));
  if (row.keyType === 2) {
    return;
  }
  const remaining = await db
    .select({ id: deployKeys.id })
    .from(deployKeys)
    .where(and(eq(deployKeys.keyId, row.keyId), eq(deployKeys.keyType, 1)))
    .limit(1);
  if (remaining.length === 0) {
    await db.delete(publicKeys).where(eq(publicKeys.id, row.keyId));
  }
}

/** LoadPublicKey (deploykey_ssh.go:46-50) for ToDeployKey's `key` field —
 *  a vanished shared row renders '' exactly like upstream's nil check. */
export async function loadDeployKeyContent(d1: D1Database, keyId: number): Promise<string | null> {
  if (keyId === 0) {
    return null;
  }
  const rows = await drizzle(d1).select({ content: publicKeys.content }).from(publicKeys).where(eq(publicKeys.id, keyId)).limit(1);
  return rows[0]?.content ?? null;
}

/**
 * ToDeployKey (convert.go:908-925): `key_type` ssh|token, `key` only for ssh
 * rows (the LoadPublicKey nil arm renders ''), the repo-API URL suffix,
 * `token` only on the create response (Token is xorm:"-" — reads never carry
 * it, and the field is omitempty), `read_only` = mode==1. The
 * `repository` arm IS appendPrivateInformation's embedded ToRepo
 * (repo/key.go:26-38), rendered with the KEY's access mode — upstream's
 * Permission{AccessMode: key.Mode} makes admin false and push = write, so
 * the permissions block overrides the viewer-based one (the key's grant, not
 * the reader's, is the payload).
 */
/** The rendered DeployKey (structs/repo_key.go:8-36) — `token` and
 *  `repository` are the omitempty fields (create-only / owner-admin-only). */
export interface ApiDeployKey {
  id: number;
  key_type: "ssh" | "token";
  key_id: number;
  key: string;
  url: string;
  title: string;
  fingerprint: string;
  token?: string;
  created_at: string;
  read_only: boolean;
  repository?: Repository;
}

export function toApiDeployKey(
  viewer: Viewer,
  pair: RepositoryWithOwner,
  row: DeployKeyRow,
  keyContent: string | null,
  options: { token?: string; withRepository?: boolean } = {},
): ApiDeployKey {
  const isSsh = row.keyType === 1;
  const base: ApiDeployKey = {
    id: row.id,
    key_type: isSsh ? "ssh" : "token",
    key_id: row.keyId,
    key: isSsh ? (keyContent ?? "") : "",
    url: `${apiRepositoryUrl(pair, viewer.origin)}/keys/${row.id}`,
    title: row.name,
    fingerprint: row.fingerprint,
    created_at: row.createdAt.toISOString(),
    read_only: row.mode === 1,
  };
  if (options.token !== undefined) {
    base.token = options.token;
  }
  if (options.withRepository === true) {
    base.repository = {
      ...toApiRepository(viewer, pair),
      permissions: { admin: false, push: row.mode === 2, pull: true },
    };
  }
  return base;
}

/**
 * The appendPrivateInformation gate (repo/key.go:31): site admin, or the
 * doer IS the repo owner (`doer.ID == ctx.Repo.Owner.ID` — the owner's
 * user-row id, which org-owned repos bind to the org row, so human org
 * owners stay outside the arm exactly like upstream). Every listed key is
 * this repo's, so the `repository.ID == key.RepoID` conjunct always holds.
 */
export function canSeePrivateDeployKey(viewer: Viewer, pair: RepositoryWithOwner): boolean {
  const requester = viewer.requester;
  if (requester === null) {
    return false;
  }
  return requester.is_admin === true || requester.id === pair.repo.ownerId;
}
