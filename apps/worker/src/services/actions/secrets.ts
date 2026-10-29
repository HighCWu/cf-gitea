/**
 * The Actions crypto-material seam (SPEC-0012 §4.4, M1b): the instance
 * token-signing secret (HS256 — the runtime JWT, the OIDC request JWT and
 * the artifacts-v4 HMAC signatures all key off it, exactly upstream's single
 * GetGeneralTokenSigningSecret), and the OIDC RS256 signing keypair.
 *
 * STORAGE HOME (the upstream-faithful port — the M2 keystore-home follow-up
 * to M1b's parking): upstream keeps NEITHER piece in a models table. The
 * HS256 secret lives in the SETTING STORE — app.ini `[oauth2] JWT_SECRET`,
 * generated once and SAVED BACK into the config when absent
 * (modules/setting/oauth2.go:129-150, served by GetGeneralTokenSigningSecret,
 * :154-164) — and the OIDC RS256 key lives in an AppData FILE
 * (`<AppDataPath>/jwt/actions_oidc.pem`, services/actions/oidc.go:40-54 via
 * LoadOrCreateAsymmetricKey, services/oauth2_provider/jwtsigningkey.go:344-413:
 * generate-once, PKCS8 PEM, temp-file + os.Link so concurrent instances
 * sharing a data path never replace each other's key). Our substrate has no
 * app.ini and no data dir (SPEC-0018 §1: ratified, no runtime-writable
 * settings store), so the analog home is the deployment-local D1 database:
 * the `system_keystore` table (schema.ts), one row per piece keyed by name —
 * `general_token_signing_secret` (the JWT_SECRET role) and
 * `actions_oidc_signing_key` (the actions_oidc.pem role; the JWK JSON is the
 * same material in Web Crypto's native format instead of PEM/PKCS8).
 *
 * SEMANTICS PORTED VERBATIM:
 *   - generate-once-save-back: a missing piece is generated and INSERTed
 *     (on-conflict-do-nothing) then READ BACK — the D1 analog of upstream's
 *     temp+link dance, strictly stronger (a row is never observable
 *     half-written; a concurrent cold load loses the insert race and ADOPTS
 *     the winner's material).
 *   - rotation is OPERATOR-ONLY, exactly upstream: upstream rotates by
 *     editing app.ini / replacing the PEM and RESTARTING; here the operator
 *     replaces or deletes the system_keystore row out-of-band
 *     (`wrangler d1 execute`) and restarts the deployment (the module-level
 *     cache is the isolate's copy of upstream's process-wide
 *     generalSigningSecret/oidcSigningKey vars). The code NEVER rewrites an
 *     existing row. A rotation invalidates every previously minted token
 *     (runners fail once and re-auth) and changes the published JWKS kid —
 *     upstream's identical semantics.
 *   - at rest the rows are plaintext JSON — the repo's ratified
 *     actions-secrets posture (the `secrets` table comment, schema.ts:
 *     "an instance key model does not exist yet"); upstream's own PEM is
 *     unencrypted on the AppData disk.
 *   - MIGRATION: deployments that predate migration 0042 hold the material in
 *     the M1b R2 object (KEYSTORE_R2_KEY). A cold load with a missing D1 row
 *     adopts the legacy object's material into D1 once (readLegacyR2Keystore)
 *     — zero-disruption continuity for the live demo deployment; R2 is then
 *     never needed again (the object can be deleted out-of-band). This
 *     adoption path may be removed once no deployment predates 0042.
 *
 * JWT shape (services/actions/auth.go:22-112): HS256 over
 *   { scp: "Actions.Results:<run>:<job>" | "Actions.IDTokenRequest",
 *     ac: <cache-scope JSON>, task_id, run_id, job_id, exp, nbf }
 * with expiry 1 h + EndlessTaskTimeout (default 3 h). Verification is
 * constant-time on the HMAC digest (crypto.subtle.verify).
 */

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { systemKeystore } from "../../db/schema";

/** EndlessTaskTimeout (modules/setting/actions.go:133-135, endless = 3 h). */
const ENDLESS_TASK_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** The fixed 1 h head on the runtime-token expiry (auth.go:48). */
const TOKEN_HEAD_MS = 60 * 60 * 1000;

/**
 * The D1 row names in system_keystore (the upstream homes' roles — see the
 * module header). `general_token_signing_secret` = app.ini
 * `[oauth2] JWT_SECRET` (GetGeneralTokenSigningSecret);
 * `actions_oidc_signing_key` = `<AppDataPath>/jwt/actions_oidc.pem`.
 */
export const KEYSTORE_SECRET_ROW = "general_token_signing_secret";
export const KEYSTORE_OIDC_ROW = "actions_oidc_signing_key";

/**
 * The LEGACY R2 key of the M1b keystore object (pre-migration-0042
 * deployments; §4.2 namespace discipline: a pure function of constant
 * segments — never user-controlled). Read ONLY by the one-time adoption path
 * on a cold D1 miss; never written anymore.
 */
export const KEYSTORE_R2_KEY = "actions/_keystore/instance.json";

/** The OIDC signing algorithm (services/actions/oidc.go:21). */
export const OIDC_SIGNING_ALGORITHM = "RS256";

interface Keystore {
  /** 64 hex chars — the raw HS256 key bytes' spelling. */
  tokenSigningSecret: string;
  /** The private RSA JWK (kty/n/e/d/p/q/dp/dq/qi) + the key id. */
  oidcPrivateJwk: JsonWebKey & { kid: string };
}

/** The system_keystore row payloads (the `v` field is format versioning for
 *  future re-spellings; 1 = the initial D1 spelling). */
interface SecretPiece {
  v: number;
  tokenSigningSecret: string;
}
interface JwkPiece {
  v: number;
  oidcPrivateJwk: JsonWebKey & { kid: string };
}

const keystoreCache = new Map<string, Promise<Keystore>>();

/**
 * TEST-ONLY: drop the module-level keystore cache — simulates an isolate
 * restart, the restart half of upstream's rotation semantics ("replace the
 * material, restart"). Never call from a request path.
 */
export function resetKeystoreCacheForTests(): void {
  keystoreCache.clear();
}

/**
 * Load-or-create the instance keystore. Module-level read-through cache: the
 * rows are deployment material (written once, read by every artifact/OIDC
 * request), the same instance-scoped class as upstream's process-wide
 * generalSigningSecret / oidcSigningKey package vars. A first-write race
 * across isolates resolves by read-back adoption (insert-once; see the
 * module header) — tokens minted before adopting fail verification once, the
 * runner retries, then the instance converges.
 */
function loadKeystore(env: Env): Promise<Keystore> {
  const cached = keystoreCache.get(KEYSTORE_SECRET_ROW);
  if (cached !== undefined) {
    return cached;
  }
  const promise = loadKeystoreFromD1(env);
  keystoreCache.set(KEYSTORE_SECRET_ROW, promise);
  promise.catch(() => keystoreCache.delete(KEYSTORE_SECRET_ROW));
  return promise;
}

/** The D1 home (the swap point's storage layer): read both rows, adopt the
 *  legacy R2 object when a row is missing (one-time migration), generate +
 *  insert-once anything still missing. */
async function loadKeystoreFromD1(env: Env): Promise<Keystore> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(systemKeystore)
    .where(inArray(systemKeystore.name, [KEYSTORE_SECRET_ROW, KEYSTORE_OIDC_ROW]));
  let secretPiece: SecretPiece | undefined;
  let jwkPiece: JwkPiece | undefined;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch (error) {
      throw new Error(`actions: keystore row ${row.name} is not valid JSON`, { cause: error });
    }
    if (row.name === KEYSTORE_SECRET_ROW) {
      secretPiece = assertSecretPiece(parsed);
    } else if (row.name === KEYSTORE_OIDC_ROW) {
      jwkPiece = assertJwkPiece(parsed);
    }
  }

  // The one-time legacy adoption (M1b's R2 object → D1): only the missing
  // pieces are adopted, and the legacy object is never written or deleted
  // here (an operator sweeps it out-of-band once the deployment is on 0042).
  if (secretPiece === undefined || jwkPiece === undefined) {
    const legacy = await readLegacyR2Keystore(env);
    if (legacy !== null) {
      if (secretPiece === undefined) {
        await insertKeystorePiece(env, KEYSTORE_SECRET_ROW, { v: 1, tokenSigningSecret: legacy.tokenSigningSecret });
        secretPiece = await readKeystorePiece(env, KEYSTORE_SECRET_ROW, assertSecretPiece);
      }
      if (jwkPiece === undefined) {
        await insertKeystorePiece(env, KEYSTORE_OIDC_ROW, { v: 1, oidcPrivateJwk: legacy.oidcPrivateJwk });
        jwkPiece = await readKeystorePiece(env, KEYSTORE_OIDC_ROW, assertJwkPiece);
      }
    }
  }

  // Generate-once-save-back (oauth2.go:134-149 / jwtsigningkey.go:344-398):
  // insert the freshly minted piece; a concurrent cold load that won the PK
  // race leaves ours conflict-skipped and the read-back adopts ITS material.
  if (secretPiece === undefined) {
    await insertKeystorePiece(env, KEYSTORE_SECRET_ROW, { v: 1, tokenSigningSecret: newTokenSigningSecret() });
    secretPiece = await readKeystorePiece(env, KEYSTORE_SECRET_ROW, assertSecretPiece);
  }
  if (jwkPiece === undefined) {
    await insertKeystorePiece(env, KEYSTORE_OIDC_ROW, { v: 1, oidcPrivateJwk: await createOidcPrivateJwk() });
    jwkPiece = await readKeystorePiece(env, KEYSTORE_OIDC_ROW, assertJwkPiece);
  }
  return { tokenSigningSecret: secretPiece.tokenSigningSecret, oidcPrivateJwk: jwkPiece.oidcPrivateJwk };
}

async function insertKeystorePiece(env: Env, name: string, piece: SecretPiece | JwkPiece): Promise<void> {
  // Plain INSERT ... ON CONFLICT DO NOTHING + read-back (the loadKeystore
  // docstring's race posture). Write-ONCE: rotation is the operator's
  // out-of-band UPDATE/DELETE + restart — no code path ever updates a row.
  const now = new Date();
  await drizzle(env.DB)
    .insert(systemKeystore)
    .values({ name, value: JSON.stringify(piece), createdAt: now, updatedAt: now })
    .onConflictDoNothing();
}

async function readKeystorePiece<T extends SecretPiece | JwkPiece>(
  env: Env,
  name: string,
  assertPiece: (value: unknown) => T,
): Promise<T> {
  const row = await drizzle(env.DB).select().from(systemKeystore).where(eq(systemKeystore.name, name)).get();
  if (row === undefined) {
    throw new Error(`actions: keystore row ${name} missing after insert (D1 write failed?)`);
  }
  try {
    return assertPiece(JSON.parse(row.value));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("actions: keystore")) throw error;
    throw new Error(`actions: keystore row ${name} is not valid JSON`, { cause: error });
  }
}

/** The legacy M1b R2 object, or null (absent — the normal case on a
 *  post-0042 deployment). */
async function readLegacyR2Keystore(env: Env): Promise<Keystore | null> {
  const existing = await env.REPO_PACKS.get(KEYSTORE_R2_KEY);
  if (existing === null) {
    return null;
  }
  return assertKeystore(await existing.json<unknown>());
}

function assertSecretPiece(value: unknown): SecretPiece {
  if (typeof value !== "object" || value === null || typeof (value as SecretPiece).tokenSigningSecret !== "string") {
    throw new Error("actions: keystore secret piece malformed");
  }
  return value as SecretPiece;
}

function assertJwkPiece(value: unknown): JwkPiece {
  const jwk = typeof value === "object" && value !== null ? (value as JwkPiece).oidcPrivateJwk : undefined;
  if (typeof jwk !== "object" || jwk === null || typeof jwk.kid !== "string") {
    throw new Error("actions: keystore OIDC piece malformed");
  }
  return value as JwkPiece;
}

/** The M1b combined-shape validator — kept for the legacy R2 adoption read. */
function assertKeystore(value: unknown): Keystore {
  if (typeof value !== "object" || value === null) {
    throw new Error("actions: keystore object malformed");
  }
  const shape = value as { tokenSigningSecret?: unknown; oidcPrivateJwk?: unknown };
  if (typeof shape.tokenSigningSecret !== "string" || typeof shape.oidcPrivateJwk !== "object" || shape.oidcPrivateJwk === null) {
    throw new Error("actions: keystore object malformed");
  }
  return value as Keystore;
}

/** 32 random bytes as 64 hex chars — the HS256 key (upstream
 *  generate.NewJwtSecretWithBase64's role; the base64-vs-hex spelling is
 *  internal-only, never on the wire). */
function newTokenSigningSecret(): string {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  let secretHex = "";
  for (const b of secretBytes) {
    secretHex += b.toString(16).padStart(2, "0");
  }
  return secretHex;
}

/** Mint the OIDC private RSA JWK (jwtsigningkey.go:344-398's generate arm:
 *  upstream RSA-4096; 2048 here — the M1b size, a documented Workers-cost
 *  divergence within the same algorithm). The kid is upstream's exact
 *  spelling: base64url(SHA-256(PKIX/SPKI DER of the public key)) —
 *  CreatePublicKeyFingerprint (util/keypair.go:48-56) + newRSASingingKey
 *  (jwtsigningkey.go:84-95). */
async function createOidcPrivateJwk(): Promise<JsonWebKey & { kid: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  // generateKey's union return: the RSA overload always yields a pair.
  if (!("privateKey" in pair)) {
    throw new Error("actions: RSA keygen did not return a pair");
  }
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (exported instanceof ArrayBuffer) {
    throw new Error("actions: RSA JWK export returned bytes");
  }
  const privateJwk: JsonWebKey = exported;
  const requireMember = (name: keyof JsonWebKey): string => {
    const v = privateJwk[name];
    if (typeof v !== "string" || v === "") {
      throw new Error(`actions: RSA JWK missing member ${String(name)}`);
    }
    return v;
  };
  // The kid: SHA-256 over the SPKI DER of the PUBLIC key, base64url-nopad
  // (upstream's fingerprint spelling — see the docstring).
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  if (!(spki instanceof ArrayBuffer)) {
    throw new Error("actions: SPKI export returned a JWK");
  }
  const kid = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
  return {
    kty: requireMember("kty"),
    n: requireMember("n"),
    e: requireMember("e"),
    d: requireMember("d"),
    p: requireMember("p"),
    q: requireMember("q"),
    dp: requireMember("dp"),
    dq: requireMember("dq"),
    qi: requireMember("qi"),
    kid,
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64.RawURLEncoding — no padding (the signed-URL spelling). */
export function base64RawUrlEncode(bytes: Uint8Array): string {
  return base64UrlEncode(bytes);
}

export function base64RawUrlDecode(value: string): Uint8Array {
  return base64UrlDecode(value);
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  const keystore = await loadKeystore(env);
  const bytes = new Uint8Array(keystore.tokenSigningSecret.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(keystore.tokenSigningSecret.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// ---------------------------------------------------------------------------
// The runtime / ID-token-request JWT family (auth.go:22-112)
// ---------------------------------------------------------------------------

/** The actionsClaims shape (auth.go:27-33). */
export interface ActionsClaims {
  scp: string;
  ac: string;
  taskId: number;
  runId: number;
  jobId: number;
  exp: number;
  nbf: number;
}

export const ID_TOKEN_REQUEST_SCOPE = "Actions.IDTokenRequest";

function cacheScopeJson(): string {
  // CreateAuthorizationToken's `ac` claim: one write-scope entry with an
  // empty scope (auth.go:38-47).
  return JSON.stringify([{ Scope: "", Permission: 2 }]);
}

/** signActionsClaims (auth.go:49-57): HS256, exp = now + 1 h + 3 h, nbf = now.
 *  The payload spells the Go struct's DEFAULT field names — actionsClaims
 *  tags only scp/ac (`json:"scp"`, `json:"ac"`), so TaskID/RunID/JobID
 *  marshal as "TaskID"/"RunID"/"JobID" (the parity wire shape). */
export async function signActionsClaims(env: Env, claims: Pick<ActionsClaims, "scp" | "taskId" | "runId" | "jobId" | "ac">): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    scp: claims.scp,
    Ac: claims.ac === "" ? cacheScopeJson() : claims.ac,
    TaskID: claims.taskId,
    RunID: claims.runId,
    JobID: claims.jobId,
    exp: now + Math.floor((TOKEN_HEAD_MS + ENDLESS_TASK_TIMEOUT_MS) / 1000),
    nbf: now,
  };
  const key = await hmacKey(env);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** CreateAuthorizationToken (auth.go:36-47) — the ACTIONS_RUNTIME_TOKEN. */
export function createAuthorizationToken(env: Env, taskId: number, runId: number, jobId: number): Promise<string> {
  return signActionsClaims(env, {
    scp: `Actions.Results:${runId}:${jobId}`,
    ac: "",
    taskId,
    runId,
    jobId,
  });
}

interface DecodedClaims extends ActionsClaims {
  expVerified: boolean;
}

async function decodeAndVerify(env: Env, token: string): Promise<DecodedClaims> {
  const parts = token.split(".");
  const [header, body, sig] = parts;
  if (parts.length !== 3 || header === undefined || body === undefined || sig === undefined) {
    throw new Error("invalid token claim");
  }
  try {
    const parsedHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { alg?: unknown };
    if (parsedHeader.alg !== "HS256") {
      throw new Error(`unexpected signing method: ${String(parsedHeader.alg)}`);
    }
  } catch {
    throw new Error("invalid token claim");
  }
  const key = await hmacKey(env);
  const ok = await crypto.subtle.verify("HMAC", key, base64UrlDecode(sig), new TextEncoder().encode(`${header}.${body}`));
  if (!ok) {
    throw new Error("invalid token claim");
  }
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) {
    throw new Error("token has expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) {
    throw new Error("token is not valid before its not-before");
  }
  const claimString = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    scp: claimString(claims.scp),
    ac: claimString(claims.Ac ?? claims.ac),
    taskId: Number(claims.TaskID ?? claims.task_id ?? 0),
    runId: Number(claims.RunID ?? claims.run_id ?? 0),
    jobId: Number(claims.JobID ?? claims.job_id ?? 0),
    exp: Number(claims.exp ?? 0),
    nbf: Number(claims.nbf ?? 0),
    expVerified: true,
  };
}

/**
 * TokenToTaskID (auth.go:86-94): verify + return the task id. When
 * `idTokenRequest` is true the token must carry the ID-token-request scope;
 * otherwise it must NOT (the exact scope-branch parity of taskIDFromToken).
 */
export async function taskIdFromToken(env: Env, token: string, idTokenRequest: boolean): Promise<number> {
  const claims = await decodeAndVerify(env, token);
  if ((claims.scp === ID_TOKEN_REQUEST_SCOPE) !== idTokenRequest) {
    throw new Error("unexpected token scope");
  }
  return claims.taskId;
}

/** ParseAuthorizationToken (auth.go:66-84) — "Bearer <jwt>" spelling. */
export async function parseAuthorizationToken(env: Env, authorizationHeader: string): Promise<number> {
  if (authorizationHeader === "") {
    return 0;
  }
  const parts = authorizationHeader.split(" ");
  if (parts.length !== 2) {
    throw new Error("split token failed");
  }
  return taskIdFromToken(env, parts[1] ?? "", false);
}

// ---------------------------------------------------------------------------
// The artifacts-v4 HMAC signature (modules/actions/artifacts.go:19-29)
// ---------------------------------------------------------------------------

/**
 * BuildSignature: HMAC-SHA256 over the tag, then each value length-prefixed
 * with a 8-byte LITTLE-ENDIAN count (the upstream shape, byte-for-byte).
 */
export async function actionsBuildSignature(env: Env, tag: string, vals: string[]): Promise<Uint8Array> {
  const key = await hmacKey(env);
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode(tag)];
  for (const v of vals) {
    const lenBuf = new Uint8Array(8);
    new DataView(lenBuf.buffer).setBigUint64(0, BigInt(v.length), true);
    chunks.push(lenBuf, encoder.encode(v));
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const message = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    message.set(c, offset);
    offset += c.length;
  }
  const sig = await crypto.subtle.sign("HMAC", key, message);
  return new Uint8Array(sig);
}

/** Constant-time-ish equality for two equal-length digests. */
export function signaturesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The OIDC RS256 key (services/actions/oidc.go:23-54)
// ---------------------------------------------------------------------------

async function oidcSigningKey(env: Env): Promise<{ privateKey: CryptoKey; kid: string }> {
  const keystore = await loadKeystore(env);
  const key = await crypto.subtle.importKey(
    "jwk",
    keystore.oidcPrivateJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { privateKey: key, kid: keystore.oidcPrivateJwk.kid };
}

/** Sign a compact JWS (RS256) over the given claims object. */
export async function signOIDCToken(env: Env, claims: Record<string, unknown>): Promise<string> {
  const { privateKey, kid } = await oidcSigningKey(env);
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: OIDC_SIGNING_ALGORITHM, typ: "JWT", kid })),
  );
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** The public JWK published at /jwks (oidc.go:31-49; use=sig added). The
 *  members are present by construction (createKeystore validated them). */
export async function oidcPublicJwk(env: Env): Promise<Record<string, string>> {
  const keystore = await loadKeystore(env);
  const jwk = keystore.oidcPrivateJwk;
  return {
    kty: jwk.kty ?? "RSA",
    n: jwk.n ?? "",
    e: jwk.e ?? "",
    kid: jwk.kid,
    use: "sig",
    alg: OIDC_SIGNING_ALGORITHM,
  };
}

/** The OIDC issuer (services/actions/oidc.go:102-104): <AppURL>api/actions/oidc. */
export function oidcIssuer(appUrl: string): string {
  return appUrl + "api/actions/oidc";
}

/** The discovery doc's claims_supported (oidc.go:56-93): the registered
 *  five + every json-tagged field of the upstream oidcClaims struct. */
export function oidcClaimsSupported(): string[] {
  return [
    "exp", "iat", "iss", "jti", "nbf", "sub",
    "aud", "actor", "actor_id", "repository", "repository_id", "repository_owner",
    "repository_owner_id", "repository_visibility", "run_id", "run_number",
    "run_attempt", "event_name", "ref", "ref_type", "ref_protected", "sha",
    "base_ref", "head_ref", "workflow", "workflow_ref", "workflow_sha",
    "job_workflow_ref", "job_workflow_sha", "runner_environment",
  ];
}
