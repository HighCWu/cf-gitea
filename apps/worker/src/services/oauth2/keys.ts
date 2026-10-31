/**
 * The per-instance OAuth2 signing key (SPEC specs/oauth2-provider.md §2.10
 * — W1 substrate): the `oauth2_signing_key` row in `system_keystore`, the
 * DIRECT 0042 precedent of `actions_oidc_signing_key` — a distinct row
 * beside it, exactly upstream's two distinct files
 * (`jwt/private.pem` jwtsigningkey.go:45 vs `jwt/actions_oidc.pem`
 * services/actions/oidc.go:45). NOT user_settings_kv: that store is
 * per-principal material; the OAuth2 signing key is instance-wide crypto
 * material — the tenant system_keystore was created for.
 *
 * SEMANTICS (the Actions module's posture verbatim):
 *   - generate-once-save-back: a missing row is generated and INSERTed
 *     (on-conflict-do-nothing) then READ BACK — a concurrent cold load
 *     loses the insert race and ADOPTS the winner's material (the D1
 *     analog of upstream's temp-file + os.Link publish dance,
 *     jwtsigningkey.go:389-392, strictly stronger).
 *   - rotation is OPERATOR-ONLY (replace/delete the row out-of-band +
 *     restart); the code never updates a row. Rotation invalidates every
 *     outstanding token (single-key JWKS — upstream identical; upstream has
 *     no rotation UI either).
 *   - the row JSON is `{v:1, alg, privateJwk}` — the Actions row's shape
 *     with the alg member the OAuth2 surface needs (the discovery document
 *     publishes exactly this alg); `privateJwk` carries the `kid` member.
 *
 * THE SYMMETRIC ARM (HS256/384/512): upstream's signing key for HS algs is
 * NOT a file — it is `[oauth2] JWT_SECRET` (GetGeneralTokenSigningSecret,
 * modules/setting/oauth2.go:129-150). Our JWT_SECRET role is served by the
 * EXISTING `general_token_signing_secret` system_keystore row (the landed
 * Actions tokenSigningSecret piece) — a SHARED row, same material both
 * consumers, exactly upstream reusing the one GetGeneralTokenSigningSecret.
 * When the configured algorithm is HS*, the oauth2_signing_key row is never
 * read or created; a missing general_token_signing_secret row is generated
 * here with the SAME 32-random-bytes-hex recipe and the SAME
 * insert-or-nothing + read-back arbitration (both modules converge on one
 * row; the loser adopts the winner's bytes). The JWKS deliberately renders
 * `kty:oct` + `alg` ONLY — hmacSigningKey.ToJWK publishes no secret members
 * (jwtsigningkey.go:69-74); parity preserved, don't "fix" it (SPEC §2.10).
 *
 * THE KID: base64url(SHA-256(SPKI DER of the public key)) —
 * CreatePublicKeyFingerprint (util/keypair.go:48-56) + newRSASingingKey
 * (jwtsigningkey.go:84-95), the Actions row's exact recipe.
 *
 * RSA modulus 2048, not upstream's 4096 (jwtsigningkey.go:354) — the
 * recorded Workers-cost divergence (SPEC §2.10 divergence (b)), matching
 * the landed Actions OIDC key.
 *
 * EdDSA is REJECTED-UNTIL-proven (jws.ts's table — SPEC divergence (c)).
 */

import { eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { systemKeystore } from "../../db/schema";
import { assertSigningAlgorithm, base64UrlEncode, DEFAULT_SIGNING_ALGORITHM, type JwsAlgorithm, publicJwkOf } from "./jws";

/** The system_keystore row name (the `jwt/private.pem` role). */
export const KEYSTORE_OAUTH2_ROW = "oauth2_signing_key";

/** The shared instance-secret row (the `[oauth2] JWT_SECRET` role) — the
 *  Actions module's row (services/actions/secrets.ts KEYSTORE_SECRET_ROW);
 *  re-declared here to keep the modules decoupled: reading it must NOT
 *  trigger the Actions keystore's own generate-both-rows side effects. */
const GENERAL_TOKEN_SIGNING_SECRET_ROW = "general_token_signing_secret";

/** True for the HMAC family — the symmetric arm (no keystore key row, no
 *  kid in token headers, the oct-only JWKS). */
export function isSymmetricAlgorithm(alg: JwsAlgorithm): boolean {
  return alg.startsWith("HS");
}

/** The asymmetric arm's material (the row's payload). */
export interface OAuth2KeyRow {
  v: 1;
  alg: JwsAlgorithm;
  /** The PRIVATE JWK (+ kid) — kty/n/e/d/p/q/dp/dq/qi for RSA,
   *  kty/crv/x/y/d for EC. */
  privateJwk: JsonWebKey & { kid: string };
}

/** What callers sign/verify/JWKS with — upstream's DefaultSigningKey split:
 *  asymmetric (the keystore row) vs symmetric (the shared instance
 *  secret). */
export type OAuth2SigningKeyRef =
  | { kind: "asymmetric"; alg: JwsAlgorithm; privateJwk: JsonWebKey & { kid: string }; kid: string; publicJwk: JsonWebKey }
  | { kind: "symmetric"; alg: JwsAlgorithm; /** The shared secret's raw hex spelling (the Actions row's). */ secretHex: string };

/** Validate + default the configured algorithm (the `OAUTH2_SIGNING_ALGO-
 *  RITHM` var's parse half — W4 wires the var; the validation is here). */
export function resolveSigningAlgorithm(configured: string | undefined): JwsAlgorithm {
  return assertSigningAlgorithm(configured ?? DEFAULT_SIGNING_ALGORITHM);
}

// Module-level read-through caches — upstream's process-wide
// defaultSigningKey / generalSigningSecret package vars; the isolate's
// copy of "load once at startup". TEST-ONLY reset below simulates the
// restart half of the rotation semantics.
const asymmetricCache = new Map<string, Promise<OAuth2SigningKeyRef>>();
const symmetricCache = new Map<string, Promise<OAuth2SigningKeyRef>>();

/**
 * TEST-ONLY: drop the module-level caches — simulates an isolate restart,
 * the restart half of upstream's rotation semantics. Never call from a
 * request path.
 */
export function resetOAuth2KeyCachesForTests(): void {
  asymmetricCache.clear();
  symmetricCache.clear();
}

/**
 * Load-or-create the instance signing key for the configured algorithm
 * (upstream DefaultSigningKey's construction, jwtsigningkey.go:415-434).
 * The alg set is validated here — anything outside the upstream set
 * (including EdDSA) fails closed on the first call.
 */
export function loadOAuth2SigningKey(db: D1Database, configuredAlgorithm?: string): Promise<OAuth2SigningKeyRef> {
  const alg = resolveSigningAlgorithm(configuredAlgorithm);
  const cache = isSymmetricAlgorithm(alg) ? symmetricCache : asymmetricCache;
  const cached = cache.get(alg);
  if (cached !== undefined) {
    return cached;
  }
  const promise = isSymmetricAlgorithm(alg) ? loadSymmetricKey(drizzle(db), alg) : loadAsymmetricKey(drizzle(db), alg);
  cache.set(alg, promise);
  promise.catch(() => cache.delete(alg));
  return promise;
}

// ---------------------------------------------------------------------------
// The asymmetric arm: the oauth2_signing_key row
// ---------------------------------------------------------------------------

async function loadAsymmetricKey(db: DrizzleD1Database, alg: JwsAlgorithm): Promise<OAuth2SigningKeyRef> {
  const row = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_OAUTH2_ROW)).get();
  if (row !== undefined) {
    const material = parseKeyRow(row.value);
    // Upstream fails closed on an alg/key-type mismatch at startup
    // (CreateJWTSigningKey errors when the PEM type differs from the
    // configured alg family — jwtsigningkey.go:240-295); ours matches the
    // family and reports the row's actual alg, which stays authoritative
    // until the operator rotates the row (the write-once posture).
    if (!algFamiliesMatch(alg, material.alg)) {
      throw new Error(
        `oauth2: configured signing algorithm ${alg} does not match the stored ${KEYSTORE_OAUTH2_ROW} key (${material.alg}) — rotate the keystore row to change algorithms`,
      );
    }
    return refFromRow(material.alg, material.privateJwk);
  }
  // Generate-once-save-back: insert-or-nothing, then READ BACK — a
  // concurrent cold load that won the PK race leaves ours conflict-skipped
  // and the read-back adopts ITS material.
  const minted = await createSigningKeyRow(alg);
  const now = new Date();
  await db
    .insert(systemKeystore)
    .values({ name: KEYSTORE_OAUTH2_ROW, value: JSON.stringify(minted), createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  const rowAfter = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_OAUTH2_ROW)).get();
  if (rowAfter === undefined) {
    throw new Error(`oauth2: keystore row ${KEYSTORE_OAUTH2_ROW} missing after insert (D1 write failed?)`);
  }
  const material = parseKeyRow(rowAfter.value);
  return refFromRow(material.alg, material.privateJwk);
}

function parseKeyRow(value: string): OAuth2KeyRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`oauth2: keystore row ${KEYSTORE_OAUTH2_ROW} is not valid JSON`, { cause: error });
  }
  const shape = parsed as OAuth2KeyRow;
  if (
    typeof shape !== "object" ||
    shape === null ||
    typeof shape.alg !== "string" ||
    typeof shape.privateJwk !== "object" ||
    shape.privateJwk === null ||
    typeof shape.privateJwk.kid !== "string"
  ) {
    throw new Error(`oauth2: keystore row ${KEYSTORE_OAUTH2_ROW} malformed`);
  }
  return shape;
}

/** Family-level match (RS* key under an RS* config etc.) — the port of
 *  upstream's key-type check; an RS256-configured deployment over an RS384
 *  row errors on the same shape as upstream's, with rotation named as the
 *  remedy. */
function algFamiliesMatch(configured: JwsAlgorithm, stored: JwsAlgorithm): boolean {
  return configured[0] === stored[0];
}

function refFromRow(alg: JwsAlgorithm, privateJwk: JsonWebKey & { kid: string }): OAuth2SigningKeyRef {
  return { kind: "asymmetric", alg, privateJwk, kid: privateJwk.kid, publicJwk: publicJwkOf(privateJwk) };
}

/** Mint the private JWK + kid (jwtsigningkey.go:344-398's generate arm,
 *  RSA at 2048 per the recorded divergence; EC picks the curve per alg).
 *  The kid is base64url(SHA-256(SPKI DER of the public key)). */
async function createSigningKeyRow(alg: JwsAlgorithm): Promise<OAuth2KeyRow> {
  const params = alg.startsWith("RS")
    ? ({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: hashFor(alg) } as const)
    : ({ name: "ECDSA", namedCurve: curveFor(alg) } as const);
  const pair = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  // generateKey's union return: every overload here yields a pair.
  if (!("privateKey" in pair)) {
    throw new Error("oauth2: key generation did not return a pair");
  }
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (exported instanceof ArrayBuffer) {
    throw new Error("oauth2: JWK export returned bytes");
  }
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  if (!(spki instanceof ArrayBuffer)) {
    throw new Error("oauth2: SPKI export returned a JWK");
  }
  const kid = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
  const privateJwk = exported as JsonWebKey & { kid: string };
  privateJwk.kid = kid;
  // The alg is validated by resolveSigningAlgorithm before we get here.
  return { v: 1, alg, privateJwk };
}

function hashFor(alg: JwsAlgorithm): "SHA-256" | "SHA-384" | "SHA-512" {
  const suffix = alg.slice(2);
  if (suffix === "256") return "SHA-256";
  if (suffix === "384") return "SHA-384";
  return "SHA-512";
}

function curveFor(alg: JwsAlgorithm): "P-256" | "P-384" | "P-521" {
  const suffix = alg.slice(2);
  if (suffix === "256") return "P-256";
  if (suffix === "384") return "P-384";
  return "P-521";
}

// ---------------------------------------------------------------------------
// The symmetric arm: the shared general_token_signing_secret row
// ---------------------------------------------------------------------------

async function loadSymmetricKey(db: DrizzleD1Database, alg: JwsAlgorithm): Promise<OAuth2SigningKeyRef> {
  const row = await db
    .select()
    .from(systemKeystore)
    .where(eq(systemKeystore.name, GENERAL_TOKEN_SIGNING_SECRET_ROW))
    .get();
  if (row !== undefined) {
    return { kind: "symmetric", alg, secretHex: parseSecretRow(row.value) };
  }
  // Generate-once-save-back with the Actions row's exact recipe (32 random
  // bytes as 64 hex chars) — GetGeneralTokenSigningSecret's generate+save
  // arm (modules/setting/oauth2.go:129-150). Whichever module (this one or
  // services/actions/secrets.ts) reaches a cold row first wins; the loser's
  // insert is conflict-skipped and its read-back adopts the winner's bytes.
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  let secretHex = "";
  for (const b of secretBytes) {
    secretHex += b.toString(16).padStart(2, "0");
  }
  const now = new Date();
  await db
    .insert(systemKeystore)
    .values({ name: GENERAL_TOKEN_SIGNING_SECRET_ROW, value: JSON.stringify({ v: 1, tokenSigningSecret: secretHex }), createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  const rowAfter = await db
    .select()
    .from(systemKeystore)
    .where(eq(systemKeystore.name, GENERAL_TOKEN_SIGNING_SECRET_ROW))
    .get();
  if (rowAfter === undefined) {
    throw new Error(`oauth2: keystore row ${GENERAL_TOKEN_SIGNING_SECRET_ROW} missing after insert (D1 write failed?)`);
  }
  return { kind: "symmetric", alg, secretHex: parseSecretRow(rowAfter.value) };
}

function parseSecretRow(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`oauth2: keystore row ${GENERAL_TOKEN_SIGNING_SECRET_ROW} is not valid JSON`, { cause: error });
  }
  const secret = (parsed as { tokenSigningSecret?: unknown }).tokenSigningSecret;
  if (typeof secret !== "string" || secret === "") {
    throw new Error(`oauth2: keystore row ${GENERAL_TOKEN_SIGNING_SECRET_ROW} malformed`);
  }
  return secret;
}

// ---------------------------------------------------------------------------
// The JWKS (GET /login/oauth/keys — W2's route consumes this)
// ---------------------------------------------------------------------------

/** The one-key JWKS render (OIDCKeys, oauth2_provider.go:482-500; ToJWK per
 *  key type — jwtsigningkey.go:69-121): RSA ⇒ kty/alg/kid/use/n/e; EC ⇒
 *  kty/alg/kid/use/crv/x/y; oct ⇒ kty/alg ONLY (no secret members — the
 *  deliberately-broken-for-third-party-OIDC HS posture, preserved). */
export async function oauth2Jwks(db: D1Database, configuredAlgorithm?: string): Promise<{ keys: Record<string, string>[] }> {
  const key = await loadOAuth2SigningKey(db, configuredAlgorithm);
  if (key.kind === "symmetric") {
    return { keys: [{ kty: "oct", alg: key.alg }] };
  }
  const pub = key.publicJwk;
  const base = { kty: pub.kty ?? "", alg: key.alg, kid: key.kid, use: "sig" };
  if ((pub.kty ?? "") === "EC") {
    return {
      keys: [{ ...base, crv: pub.crv ?? "", x: pub.x ?? "", y: pub.y ?? "" }],
    };
  }
  return { keys: [{ ...base, n: pub.n ?? "", e: pub.e ?? "" }] };
}
