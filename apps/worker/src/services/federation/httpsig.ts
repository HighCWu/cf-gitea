/**
 * The HTTP-signature verifier (SPEC specs/federation.md §6.2, W-B3
 * as-built 2026-11-01) — the port of upstream's deleted
 * `routers/api/v1/activitypub/reqsignature.go` (draft-cavage-http-signatures
 * over `42wim/httpsig`, retracted by PR #36789), hand-rolled on WebCrypto:
 * the canonical signing string rebuilt from the `Signature` header's
 * parameter list, verified with RSASSA-PKCS1-v1_5/SHA-256 (upstream's
 * `Algorithms[0]` — the only algorithm the deleted middleware ever ran,
 * setting default `["rsa-sha256", ...]` read at index 0).
 *
 * The upstream flow, arm for arm (reqsignature.go:64-90):
 *   1. parse the Signature header (`httpsig.NewVerifier`) — failure is an
 *      ERROR arm (upstream: APIErrorInternal → 500; the deleted integration
 *      test's unsigned-POST pin);
 *   2. `keyId` is an IRI — parsed as a URL, then FETCHED over HTTP (the
 *      first outbound federation fetch: Accept: the ActivityStreams content
 *      type, 200-only, body capped at Federation.MaxSize);
 *   3. the actor document's `publicKey` must carry `id == keyId` and a
 *      `PUBLIC KEY` PEM (`getPublicKeyFromResponse`:24-44) — shape failures
 *      are ERROR arms, exactly upstream's;
 *   4. crypto verification (the `v.Verify` stage) — every failure there is
 *      the REJECTED arm: upstream `authenticated = (Verify(...) == nil)` →
 *      `APIError(403, "request signature verification failed")` (:91-93).
 *
 * Beyond upstream's bare verifier, three fail-closed arms the SPEC §3.1/§7
 * commit to (each recorded in §6.2 as-built):
 *   - Digest: a present `Digest` header must carry a `SHA-256=` entry equal
 *     to the SHA-256 of the received body — the tampered-body vector, and
 *     the body-integrity gate for the inbox's (new) body read;
 *   - Date freshness: when the signed list includes `date`, the header must
 *     parse and sit within ±60 s of now — upstream's own signer expiry
 *     (`httpsigExpirationTime = 60`, client.go:27), applied to inbound
 *     verification;
 *   - algorithm: a present `algorithm` parameter must be `rsa-sha256`
 *     (hs2019/rsa-sha512/ed25519 → rejected — upstream verified ONLY with
 *     Algorithms[0] regardless of the parameter).
 *
 * Remote-key cache (OQ-4): NOT built. The SPEC §4.5 divergence named a TTL
 * cache home (D1 `remote_actor_keys` or KV), but as-built neither sanctioned
 * home exists — no migration grant and no KV binding in the worker config —
 * so verification runs upstream's exact fetch-per-verification posture. The
 * `fetchImpl` option is the seam a cache slots into later; the outcome
 * semantics do not change either way.
 *
 * `signSigningString`/`renderSignatureHeader` are the deleted client.go
 * signer's canonical-string half, exported for the fixed-vector battery
 * (SPEC §7: "WebCrypto-generate an RSA test pair; helpers produce signed
 * requests over the canonical string") and for the route-level inbox tests'
 * fixture remote actors; no production caller exists yet (W-B5's delivery
 * consumer is still contingent on OQ-5).
 */

/** `ActivityStreamsContentType` (modules/activitypub/client.go:23-24 at
 *  `1592576fa5^`) — the Person document's and the Accept body's
 *  Content-Type, and the outbound keyId fetch's Accept. */
export const ACTIVITY_STREAMS_CONTENT_TYPE = `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`;

/** Upstream `Federation.MaxSize` default (modules/setting/federation.go:24,
 *  loader :45 converts MiB → bytes) — the deleted fetch's LimitReader cap;
 *  ours also bounds the inbox body read (SPEC §3.1). Dead config at the pin,
 *  so a module constant, not a var (no new config surface). */
export const FEDERATION_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Upstream `httpsigExpirationTime` (client.go:27) — the signer's 60 s
 *  expiry, enforced inbound on a signed `date` header. */
export const SIGNATURE_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// Base64 + PEM codec (the distro-common substrate, our own copy — that
// module's helpers are private)
// ---------------------------------------------------------------------------

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** atob throws on invalid base64 — callers that care catch and map. */
export function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** PEM armor around DER bytes — 64-char base64 lines, the Go
 *  encoding/pem wire form. */
export function pemEncode(label: string, der: Uint8Array): string {
  const base64 = base64Encode(der);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** `pem.Decode` + the block-type check upstream folds into
 *  getPublicKeyFromResponse (`block.Type != "PUBLIC KEY"` → error). */
export function pemDecode(pem: string, label: string): Uint8Array | null {
  const match = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+?)-----END ${label}-----`).exec(pem);
  if (match === null) return null;
  const base64 = (match[1] ?? "").replace(/\s+/g, "");
  try {
    return base64Decode(base64);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The Signature header (draft-cavage parameter list)
// ---------------------------------------------------------------------------

export interface SignatureParams {
  keyId: string;
  algorithm?: string;
  /** The `headers` parameter split on whitespace; undefined = the draft's
   *  default (the Date header alone). */
  headers?: string[];
  signatureBase64: string;
  created?: string;
  expires?: string;
}

/** Split `key="value",key2=value2` honoring quotes and backslash escapes
 *  (the draft's sig-params grammar; base64 padding lives INSIDE the quotes,
 *  so a naive comma split would cut it). Param keys lower-cased. */
function splitSignatureParams(raw: string): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && (raw[i] === " " || raw[i] === ",")) i++;
    const eq = raw.indexOf("=", i);
    if (eq < 0) break;
    const key = raw.slice(i, eq).trim().toLowerCase();
    if (key === "") break;
    i = eq + 1;
    while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
    let value: string;
    if (raw[i] === '"') {
      i++;
      value = "";
      while (i < raw.length && raw[i] !== '"') {
        if ((raw[i] === "\\" && raw[i + 1] === '"') || (raw[i] === "\\" && raw[i + 1] === "\\")) {
          value += raw[i + 1];
          i += 2;
        } else {
          value += raw[i];
          i++;
        }
      }
      i++; // the closing quote (or end-of-string)
    } else {
      const comma = raw.indexOf(",", i);
      value = (comma < 0 ? raw.slice(i) : raw.slice(i, comma)).trim();
      i = comma < 0 ? raw.length : comma;
    }
    params.push([key, value]);
  }
  return params;
}

/**
 * The `Signature:` header body → params. Missing keyId or signature → null
 * (an unparseable header — upstream `NewVerifier`'s error arm).
 */
export function parseSignatureParams(raw: string): SignatureParams | null {
  const pairs = splitSignatureParams(raw);
  let keyId = "";
  let signatureBase64 = "";
  let algorithm: string | undefined;
  let headers: string[] | undefined;
  let created: string | undefined;
  let expires: string | undefined;
  for (const [key, value] of pairs) {
    switch (key) {
      case "keyid":
        keyId = value;
        break;
      case "algorithm":
        algorithm = value;
        break;
      case "headers":
        headers = value
          .split(/\s+/)
          .map((item) => item.trim())
          .filter((item) => item !== "");
        break;
      case "signature":
        signatureBase64 = value;
        break;
      case "created":
        created = value;
        break;
      case "expires":
        expires = value;
        break;
      default:
        break; // unknown parameters are ignored (the draft's forward-compat rule)
    }
  }
  if (keyId === "" || signatureBase64 === "") return null;
  return {
    keyId,
    ...(algorithm === undefined ? {} : { algorithm }),
    ...(headers === undefined ? {} : { headers }),
    signatureBase64,
    ...(created === undefined ? {} : { created }),
    ...(expires === undefined ? {} : { expires }),
  };
}

/** The draft's alternative carriage: `Authorization: Signature <params>`. */
function authorizationSignature(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Signature\s+([\s\S]*)$/i.exec(header);
  return match === null ? undefined : (match[1] ?? "");
}

// ---------------------------------------------------------------------------
// The canonical signing string
// ---------------------------------------------------------------------------

/** The request slice the signing string rebuilds from — header lookup is
 *  case-insensitive per the fetch Headers model. */
export interface HttpSignatureRequestSlice {
  method: string;
  /** The (request-target) value: path + query, e.g. `/api/v1/.../inbox?a=b`. */
  pathWithQuery: string;
  header: (name: string) => string | undefined;
}

/**
 * draft-cavage §2.3: one `header: value` line per listed header, lowercased
 * names, joined with "\n"; `(request-target)` renders
 * `method: lowercase-method SPACE path?query`; the `(created)`/`(expires)`
 * pseudo-headers read the Signature parameters of the same name. A listed
 * header absent from the request (or a pseudo-header with no parameter)
 * returns null — the verify stage maps that to rejected.
 */
export function buildSigningString(
  request: HttpSignatureRequestSlice,
  headerList: string[],
  pseudo?: { created?: string; expires?: string },
): string | null {
  const lines: string[] = [];
  for (const raw of headerList) {
    const item = raw.trim().toLowerCase();
    if (item === "(request-target)") {
      lines.push(`(request-target): ${request.method.toLowerCase()} ${request.pathWithQuery}`);
    } else if (item === "(created)") {
      if (pseudo?.created === undefined) return null;
      lines.push(`(created): ${pseudo.created}`);
    } else if (item === "(expires)") {
      if (pseudo?.expires === undefined) return null;
      lines.push(`(expires): ${pseudo.expires}`);
    } else {
      const value = request.header(item);
      if (value === undefined) return null;
      lines.push(`${item}: ${value}`);
    }
  }
  return lines.join("\n");
}

/** The Digest header value for a body: `SHA-256=<base64 digest>` (upstream
 *  DigestAlgorithm "SHA-256", the setting loader's only validated arm). */
export async function computeSha256Digest(body: Uint8Array): Promise<string> {
  const sum = await crypto.subtle.digest("SHA-256", body);
  return `SHA-256=${base64Encode(new Uint8Array(sum))}`;
}

/** A present Digest header must carry a SHA-256 entry equal to the body's
 *  digest (case-insensitive algorithm; multiple entries take the first
 *  sha-256 one; no sha-256 entry → fail). */
async function digestMatches(digestHeader: string, body: Uint8Array): Promise<boolean> {
  const expected = await computeSha256Digest(body);
  for (const part of digestHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const algorithm = part.slice(0, eq).trim().toLowerCase();
    if (algorithm === "sha-256") return part.slice(eq + 1).trim() === expected.slice("SHA-256=".length);
  }
  return false;
}

/** RSASSA-PKCS1-v1_5 over the canonical string (the message is hashed by
 *  WebCrypto — SHA-256 via the imported key's algorithm). */
export async function signSigningString(signingString: string, privateKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signingString));
  return base64Encode(new Uint8Array(signature));
}

/** The Signature header body in the draft's canonical parameter order. */
export function renderSignatureHeader(params: {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
}): string {
  return `keyId="${params.keyId}",algorithm="${params.algorithm}",headers="${params.headers.join(" ")}",signature="${params.signature}"`;
}

// ---------------------------------------------------------------------------
// The bounded body read (the inbox's cap — SPEC §3.1)
// ---------------------------------------------------------------------------

export type BoundedBody = { ok: true; body: Uint8Array } | { ok: false };

/**
 * Stream-read a body capped at `cap` bytes — the FixedLengthStream
 * discipline (never `.text()` on unbounded input). Over-cap → `{ok:false}`
 * (the reader cancelled; the caller answers its size arm). The minimal
 * structural slice fits BOTH the inbound Request and the outbound
 * actor-document Response (upstream's cap rode the fetch's LimitReader).
 */
export async function readBodyBounded(
  source: { body: ReadableStream<Uint8Array> | null },
  cap: number,
): Promise<BoundedBody> {
  if (source.body === null) return { ok: true, body: new Uint8Array(0) };
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.length;
    if (total > cap) {
      void reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

export type HttpSignatureOutcome =
  | { kind: "verified"; keyId: string }
  | { kind: "rejected"; reason: string }
  | { kind: "error"; reason: string };

export interface VerifyHttpSignatureOptions {
  /** The outbound actor-document fetch — default `fetch`. The OQ-4 cache
   *  seam; tests stub it (SPEC §7's env-boundary stubbing). */
  fetchImpl?: typeof fetch;
  /** Wall clock, epoch ms — tests pin freshness deterministically. */
  now?: number;
  ttlSeconds?: number;
  /** The actor-document read cap — default FEDERATION_MAX_BODY_BYTES. */
  maxDocumentBytes?: number;
}

/** The fetched actor document's `publicKey` property — strict object form
 *  (upstream unmarshalled into go-ap's single-valued Person.PublicKey). */
function extractPublicKey(doc: unknown): { id: string; publicKeyPem: string } | null {
  if (typeof doc !== "object" || doc === null) return null;
  const candidate = (doc as Record<string, unknown>)["publicKey"];
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.publicKeyPem !== "string") return null;
  return { id: record.id, publicKeyPem: record.publicKeyPem };
}

/**
 * The reqsignature.go ladder. Outcomes map onto HTTP at the route:
 *   error    → the APIErrorInternal arm (house 500, `internal server error`)
 *   rejected → `403 request signature verification failed` (the exact body)
 */
export async function verifyHttpSignature(
  request: HttpSignatureRequestSlice,
  body: Uint8Array,
  options: VerifyHttpSignatureOptions = {},
): Promise<HttpSignatureOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const ttl = (options.ttlSeconds ?? SIGNATURE_TTL_SECONDS) * 1000;
  const maxDocumentBytes = options.maxDocumentBytes ?? FEDERATION_MAX_BODY_BYTES;

  // 1. The Signature header (NewVerifier's arm) — the Authorization scheme
  //    is the draft's alternative carriage.
  const headerBody = request.header("signature") ?? authorizationSignature(request.header("authorization"));
  if (headerBody === undefined || headerBody === "") {
    return { kind: "error", reason: "missing Signature header" };
  }
  const params = parseSignatureParams(headerBody);
  if (params === null) {
    return { kind: "error", reason: "unparseable Signature header" };
  }
  const headerList = params.headers ?? ["date"];

  // 2. keyId is an IRI (reqsignature.go:69-72's url.Parse — a parse failure
  //    is an error arm; a non-fetchable protocol fails the fetch below, so
  //    the http/https gate just short-circuits the same outcome).
  let keyUrl: URL;
  try {
    keyUrl = new URL(params.keyId);
  } catch {
    return { kind: "error", reason: "unparseable keyId IRI" };
  }
  if (keyUrl.protocol !== "http:" && keyUrl.protocol !== "https:") {
    return { kind: "error", reason: "unsupported keyId protocol" };
  }

  // 3. The algorithm parameter (the verifier runs Algorithms[0] only).
  if (params.algorithm !== undefined && params.algorithm !== "rsa-sha256") {
    return { kind: "rejected", reason: `unsupported signature algorithm: ${params.algorithm}` };
  }

  // 4. Date freshness (client.go:27's 60 s signer expiry, applied inbound).
  if (headerList.includes("date")) {
    const dateValue = request.header("date");
    if (dateValue === undefined) return { kind: "rejected", reason: "missing Date header" };
    const parsed = Date.parse(dateValue);
    if (Number.isNaN(parsed)) return { kind: "rejected", reason: "unparseable Date header" };
    if (Math.abs(now - parsed) > ttl) return { kind: "rejected", reason: "stale Date header" };
  }

  // 5. The canonical signing string (a missing signed header = the
  //    v.Verify stage's failure → rejected, matching 42wim's error-as-false).
  const signingString = buildSigningString(request, headerList, params);
  if (signingString === null) {
    return { kind: "rejected", reason: "a signed header is missing from the request" };
  }

  // 6. The Digest gate — body integrity for the inbox's streamed read.
  const digestHeader = request.header("digest");
  if (digestHeader !== undefined && !(await digestMatches(digestHeader, body))) {
    return { kind: "rejected", reason: "Digest header does not match the body" };
  }

  // 7. Fetch the keyId IRI (fetch(), reqsignature.go:46-60 — Accept:
  //    ActivityStreams, 200-only, MaxSize-capped).
  let response: Response;
  try {
    response = await fetchImpl(keyUrl.toString(), {
      headers: { accept: ACTIVITY_STREAMS_CONTENT_TYPE, "user-agent": "Gitea" },
    });
  } catch (cause) {
    return { kind: "error", reason: `keyId fetch failed: ${String(cause)}` };
  }
  if (response.status !== 200) {
    return { kind: "error", reason: `keyId fetch failed with status ${response.status}` };
  }
  const spooled = await readBodyBounded(response, maxDocumentBytes);
  if (!spooled.ok) {
    return { kind: "error", reason: "actor document exceeds the maximum size" };
  }

  // 8. Extract the key (getPublicKeyFromResponse:24-44) — shape failures are
  //    error arms, upstream's APIErrorInternal mapping exactly.
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(spooled.body));
  } catch {
    return { kind: "error", reason: "actor document is not JSON" };
  }
  const publicKey = extractPublicKey(document);
  if (publicKey === null) {
    return { kind: "error", reason: "actor document carries no publicKey property" };
  }
  if (publicKey.id !== params.keyId) {
    return { kind: "error", reason: `cannot find publicKey with id: ${params.keyId} in the fetched document` };
  }
  const der = pemDecode(publicKey.publicKeyPem, "PUBLIC KEY");
  if (der === null) {
    return { kind: "error", reason: "could not decode publicKeyPem to PUBLIC KEY pem block type" };
  }
  let verificationKey: CryptoKey;
  try {
    verificationKey = await crypto.subtle.importKey(
      "spki",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch (cause) {
    return { kind: "error", reason: `publicKeyPem import failed: ${String(cause)}` };
  }

  // 9. Verify — the v.Verify stage: EVERY failure here (bad base64, wrong
  //    key, bad padding) reads as unauthenticated (upstream: Verify error →
  //    authenticated=false → 403).
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64Decode(params.signatureBase64);
  } catch {
    return { kind: "rejected", reason: "signature is not valid base64" };
  }
  try {
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      verificationKey,
      signatureBytes,
      new TextEncoder().encode(signingString),
    );
    return verified ? { kind: "verified", keyId: params.keyId } : { kind: "rejected", reason: "signature mismatch" };
  } catch (cause) {
    return { kind: "rejected", reason: `signature verification failed: ${String(cause)}` };
  }
}
