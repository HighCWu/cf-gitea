/**
 * The Actions crypto-material seam (SPEC-0012 §4.4, M1b): the instance
 * token-signing secret (HS256 — the runtime JWT, the OIDC request JWT and
 * the artifacts-v4 HMAC signatures all key off it, exactly upstream's single
 * GetGeneralTokenSigningSecret), and the OIDC RS256 signing keypair.
 *
 * STORAGE POSTURE (documented divergence from §4.4's spellings): §4.4 puts
 * the signing secret in a `wrangler secret` and the RS256 PEM (AES-encrypted)
 * in D1. Both homes require files outside this unit's exclusive ownership
 * (wrangler.jsonc.example / schema.ts + a migration), so M1b persists the
 * material in a single private R2 object under the SPEC's own `actions/`
 * namespace — Worker-only readable, generated once, never rotated by code.
 * The function seam below is the swap point: landing the wrangler secret or
 * the D1 keystore replaces `loadKeystore` alone. Recorded for the SPEC's
 * divergence ledger.
 *
 * JWT shape (services/actions/auth.go:22-112): HS256 over
 *   { scp: "Actions.Results:<run>:<job>" | "Actions.IDTokenRequest",
 *     ac: <cache-scope JSON>, task_id, run_id, job_id, exp, nbf }
 * with expiry 1 h + EndlessTaskTimeout (default 3 h). Verification is
 * constant-time on the HMAC digest (crypto.subtle.verify).
 */

/** EndlessTaskTimeout (modules/setting/actions.go:133-135, endless = 3 h). */
const ENDLESS_TASK_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** The fixed 1 h head on the runtime-token expiry (auth.go:48). */
const TOKEN_HEAD_MS = 60 * 60 * 1000;

/** The R2 key of the instance keystore object (§4.2 namespace discipline:
 *  a pure function of constant segments — never user-controlled). */
export const KEYSTORE_R2_KEY = "actions/_keystore/instance.json";

/** The OIDC signing algorithm (services/actions/oidc.go:21). */
export const OIDC_SIGNING_ALGORITHM = "RS256";

interface Keystore {
  /** 64 hex chars — the raw HS256 key bytes' spelling. */
  tokenSigningSecret: string;
  /** The private RSA JWK (kty/n/e/d/p/q/dp/dq/qi) + the key id. */
  oidcPrivateJwk: JsonWebKey & { kid: string };
}

const keystoreCache = new Map<string, Promise<Keystore>>();

/**
 * Load-or-create the instance keystore. Module-level read-through cache:
 * the object is deployment material (written once, read by every artifact/
 * OIDC request), the same instance-scoped class as M1a's pick limiter. A
 * first-write race across isolates resolves by re-reading (conditional PUT;
 * the loser adopts the winner's material — tokens minted before adopting
 * fail verification once, the runner retries, then the instance converges).
 */
function loadKeystore(env: Env): Promise<Keystore> {
  const cached = keystoreCache.get(KEYSTORE_R2_KEY);
  if (cached !== undefined) {
    return cached;
  }
  const promise = (async () => {
    const existing = await env.REPO_PACKS.get(KEYSTORE_R2_KEY);
    if (existing !== null) {
      const parsed = await existing.json<unknown>();
      return assertKeystore(parsed);
    }
    const created = await createKeystore();
    // Plain PUT + read-back adoption: workerd's conditional-put semantics
    // for a not-yet-existing key differ across binding simulations, and the
    // material must LAND. A concurrent first-write race resolves by the
    // read-back: a loser adopts the winner's material on its next cold load
    // (tokens minted in between fail verification once and the runner
    // retries — a deployment-moment window, not a steady state).
    await env.REPO_PACKS.put(KEYSTORE_R2_KEY, JSON.stringify(created));
    const written = await env.REPO_PACKS.get(KEYSTORE_R2_KEY);
    if (written !== null) {
      const parsed = await written.json<unknown>();
      const stored = assertKeystore(parsed);
      if (stored.tokenSigningSecret !== created.tokenSigningSecret) {
        // Another isolate won the race — adopt ITS material.
        keystoreCache.set(KEYSTORE_R2_KEY, Promise.resolve(stored));
        return stored;
      }
    }
    return created;
  })();
  keystoreCache.set(KEYSTORE_R2_KEY, promise);
  promise.catch(() => keystoreCache.delete(KEYSTORE_R2_KEY));
  return promise;
}

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

async function createKeystore(): Promise<Keystore> {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  let secretHex = "";
  for (const b of secretBytes) {
    secretHex += b.toString(16).padStart(2, "0");
  }
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
  // The kid is the RFC 7638 thumbprint of the required public members.
  const kid = await rfc7638Thumbprint({ e: requireMember("e"), kty: requireMember("kty"), n: requireMember("n") });
  return {
    tokenSigningSecret: secretHex,
    oidcPrivateJwk: {
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
    },
  };
}

/** RFC 7638 section 3.1 — the SHA-256 thumbprint over the lexicographically
 *  ordered required members, base64url-nopad. */
async function rfc7638Thumbprint(parts: { e: string; kty: string; n: string }): Promise<string> {
  const canonical = `{"e":"${parts.e}","kty":"${parts.kty}","n":"${parts.n}"}`;
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
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
