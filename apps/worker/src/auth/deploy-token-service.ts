/**
 * Deploy-token verification for the git-HTTP gate — the upstream
 * `deploykey` token model behind the DeployToken auth method
 * (services/auth/deploy_token.go:27-46), which the pin registers on the
 * git-HTTP routes BEFORE Basic ("before Basic, which would try the token as
 * a password", routers/web/web.go:135-136).
 *
 * Credential shape at the pin (fc493688): `gdt_` + 43 alphanumerics — 256
 * bits over the 62-char alphabet, the prefix existing so "a secret scanner
 * [can] recognize a leaked token" (models/deploykey/deploykey_token.go:18-21).
 * Rows keep sha256(token) (`token_hash` — "sha256 … need[s] no salt") with
 * `key_type = 2` (KeyTypeToken); verification is the prefix gate — which
 * "spares a query for every password of a normal user" (deploykey_token.go:65)
 * — plus one hash-equality lookup, exactly upstream's VerifyDeployKeyToken
 * (:64-76). The header side is upstream's Basic token candidate (basic.go
 * parseAuthBasic, ported in httpauth.ts): the token rides the username
 * (empty password), the `x-oauth-basic` form, or the password field — never
 * a Bearer scheme (parseAuthBasic reads only the Basic header).
 *
 * Permission semantics (enforced by the gate's matrix, acl.ts): the key
 * alone is the actor. Upstream's synthetic key user holds exactly
 * getDeployKeyRepoPermission (models/perm/access/repo_permission.go:387-409)
 * — the code+wiki units of ITS OWN repository at `mode` (1 = read, 2 =
 * write) — so the credential can never reach another repository or exceed
 * its access mode. This module only resolves the row; the repo-match and
 * mode decisions live in the ACL matrix.
 *
 * No schema work: every needed column landed with the deploy-keys API
 * family (key_type/token_hash/mode/repo_id — the db schema comment reserved
 * `updated_unix` as last-used "once the git-HTTP arm lands", the HasUsed
 * gate deploykey.go:51). The token_hash INDEX was audit-dropped as
 * query-dead and is re-added by a future migration; until then the lookup
 * is one hash equality over a per-repo-sized table.
 *
 * Last-used touch: upstream's UpdateDeployKeyLastUsed (deploykey.go:72-75)
 * writes `updated_unix` on EVERY successful verification; cf-gitea applies
 * the SPEC-0002 §2.7 24 h throttle the access-token arm already uses (one
 * D1 write per day per key — the HasUsed/HasRecentActivity gates only need
 * the first use to move the stamp off `created_unix`).
 */

import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sha256Hex } from "./digest";
import { LAST_USED_THROTTLE_MS } from "./token-service";
import { deployKeys } from "../db/schema";

/** Upstream DeployTokenPrefix (deploykey_token.go:19). */
export const DEPLOY_TOKEN_PREFIX = "gdt_";
/** Upstream KeyTypeToken (deploykey.go KeyType; ssh rows are 1). */
const KEY_TYPE_TOKEN = 2;

/** The resolved deploy-key row — the whole grant the gate decides on. */
export interface VerifiedDeployKey {
  id: number;
  /** repositories.id (TEXT) — the ONE repository the key reaches. */
  repoId: string;
  /** Raw perm.AccessMode integer: 1 = read, 2 = write. */
  mode: number;
  /** Upstream CreatedUnix/UpdatedUnix (the latter doubles as last-used). */
  createdAt: Date;
  updatedAt: Date;
}

/**
 * VerifyDeployKeyToken (deploykey_token.go:64-76): prefix gate → sha256 →
 * one `(token_hash, key_type = token)` row. Returns `null` for a non-`gdt_`
 * credential (the candidate is a user password or an access token — the
 * caller's other auth arms try it) and for an unknown/revoked token alike.
 */
export async function verifyDeployToken(d1: D1Database, token: string): Promise<VerifiedDeployKey | null> {
  if (!token.startsWith(DEPLOY_TOKEN_PREFIX)) return null;
  const digest = await sha256Hex(token);
  const row = await drizzle(d1)
    .select({
      id: deployKeys.id,
      repoId: deployKeys.repoId,
      mode: deployKeys.mode,
      createdAt: deployKeys.createdAt,
      updatedAt: deployKeys.updatedAt,
    })
    .from(deployKeys)
    .where(and(eq(deployKeys.tokenHash, digest), eq(deployKeys.keyType, KEY_TYPE_TOKEN)))
    .get();
  return row ?? null;
}

/** True when the key's last-used stamp should move now (24 h throttle —
 *  the TokenService.needsLastUsedTouch semantics over `updated_unix`). */
export function needsDeployKeyLastUsedTouch(key: VerifiedDeployKey, now: Date): boolean {
  return now.getTime() - key.updatedAt.getTime() >= LAST_USED_THROTTLE_MS;
}

/** UpdateDeployKeyLastUsed (deploykey.go:72-75), throttled; attach via
 *  `ctx.waitUntil` in request paths. */
export async function touchDeployKeyLastUsed(d1: D1Database, keyId: number, now: Date): Promise<void> {
  await drizzle(d1)
    .update(deployKeys)
    .set({ updatedAt: now })
    .where(eq(deployKeys.id, keyId))
    .run();
}
