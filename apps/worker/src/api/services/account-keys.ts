import type { Context } from "hono";
import { asc, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { gpgKeys, publicKeys } from "../../db/schema";
import type { ApiEnv } from "../env";
import { GO_ZERO_TIME, viewerOf, type UserRow } from "./repository";
import { toApiUser } from "./user";

/**
 * The account-family key/gpg row→API mapping layer — the ONE home for the
 * mappers the account routes share (`toApiPublicKey`/`publicKeyApiLink`,
 * `toApiGpgKey`, `loadSubkeys`). The bodies originated in routes/misc-t3.ts
 * (the user/emails/keys/gpg + admin emails/keys module) and were copied
 * verbatim into routes/identity.ts (the /users/{username} key/gpg listings —
 * the same verbatim-copy precedent as misc-t3's own copies of admin-t2.ts's
 * private seams); this module is the consolidation the copies' headers named
 * as the open follow-up. Routes import from here; behavior is unchanged.
 *
 * Upstream anchors (per-function doc comments carry the line-level cites):
 *   - publicKeyApiLink / toApiPublicKey — convert.ToPublicKey
 *     (convert.go:840-851) + appendPrivateInformation (key.go:26-47)
 *   - toApiGpgKey — convert.ToGPGKey (convert.go:853-890)
 *   - loadSubkeys — LoadSubKeys (gpg_key_list.go:22-40)
 */

function publicKeyApiLink(origin: string): string {
  return `${origin}/api/v1/user/keys/`;
}

/** convert.ToPublicKey (convert.go:840-851) + appendPrivateInformation
 *  (key.go:26-47) when the viewer is the owner or a site admin. */
export function toApiPublicKey(
  c: Context<ApiEnv>,
  row: typeof publicKeys.$inferSelect,
  owner: UserRow | null,
  includePrivate: boolean,
) {
  const base = {
    id: row.id,
    key: row.content,
    url: `${publicKeyApiLink(new URL(c.req.url).origin)}${row.id}`,
    title: row.name,
    fingerprint: row.fingerprint,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.updatedAt.toISOString(),
  };
  if (!includePrivate || owner === null) {
    return base;
  }
  return {
    ...base,
    user: toApiUser(viewerOf(c), owner),
    read_only: row.mode === 1,
    key_type: "user",
  };
}

/** convert.ToGPGKey (convert.go:853-890): emails always [] (the parse-time
 *  field is never loaded on reads — misc-t3 module header), expires renders
 *  Go's zero time when the key never expires. */
export function toApiGpgKey(row: typeof gpgKeys.$inferSelect, subkeyRows: typeof gpgKeys.$inferSelect[]) {
  return {
    id: row.id,
    primary_key_id: row.primaryKeyId,
    key_id: row.keyId,
    public_key: row.content,
    emails: [] as { email: string; verified: boolean }[],
    subkeys: subkeyRows.map((subkey) => ({
      id: subkey.id,
      primary_key_id: subkey.primaryKeyId,
      key_id: subkey.keyId,
      public_key: subkey.content,
      emails: [] as { email: string; verified: boolean }[],
      subkeys: [] as unknown[],
      can_sign: subkey.canSign,
      can_encrypt_comms: subkey.canEncryptComms,
      can_encrypt_storage: subkey.canEncryptStorage,
      can_certify: subkey.canCertify,
      verified: subkey.verified,
      created_at: subkey.createdAt.toISOString(),
      expires_at: subkey.expiresAt === null ? GO_ZERO_TIME : subkey.expiresAt.toISOString(),
    })),
    can_sign: row.canSign,
    can_encrypt_comms: row.canEncryptComms,
    can_encrypt_storage: row.canEncryptStorage,
    can_certify: row.canCertify,
    verified: row.verified,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt === null ? GO_ZERO_TIME : row.expiresAt.toISOString(),
  };
}

/** LoadSubKeys (gpg_key_list.go:22-40) — one IN query grouped by parent. */
export async function loadSubkeys(d1: D1Database, keyIds: string[]): Promise<Map<string, typeof gpgKeys.$inferSelect[]>> {
  const grouped = new Map<string, typeof gpgKeys.$inferSelect[]>();
  if (keyIds.length === 0) {
    return grouped;
  }
  const rows = await drizzle(d1)
    .select()
    .from(gpgKeys)
    .where(inArray(gpgKeys.primaryKeyId, keyIds))
    .orderBy(asc(gpgKeys.id));
  for (const row of rows) {
    const list = grouped.get(row.primaryKeyId) ?? [];
    list.push(row);
    grouped.set(row.primaryKeyId, list);
  }
  return grouped;
}
