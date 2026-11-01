/**
 * The HTTP-signature fixed vectors (SPEC specs/federation.md §7, W-B3
 * as-built) — fixtures-first over real WebCrypto: two RSA-3072 pairs
 * generated in-suite, the canonical-string helpers producing every signed
 * request, the remote actor served by a stubbed `fetchImpl` (the
 * gitclient/monitor `FetchImpl` seam — NO real network).
 *
 * Vector set (each maps onto an HTTP arm at the route — error → house 500,
 * rejected → `403 request signature verification failed`):
 *   good signature; tampered body (digest mismatch); stale Date past the
 *   60 s expiry the deleted client used; wrong key (signature by a foreign
 *   pair against the doc's key); unknown keyId (fetch-miss → fail-closed);
 *   unsupported algorithm → reject; malformed/garbage header and
 *   unreachable keyId → the upstream error arm (reqsignature.go's
 *   APIErrorInternal, the deleted integration test's unsigned-POST 500);
 *   malformed-PEM and id-mismatched actor documents → the same error arm
 *   (getPublicKeyFromResponse's failures); over-MaxSize actor document.
 *
 * Pure WebCrypto + parsing only — no bindings; the D1-backed keypair store
 * and the route battery live in federation.test.ts.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  ACTIVITY_STREAMS_CONTENT_TYPE,
  base64Decode,
  base64Encode,
  buildSigningString,
  computeSha256Digest,
  parseSignatureParams,
  pemDecode,
  pemEncode,
  readBodyBounded,
  renderSignatureHeader,
  signSigningString,
  verifyHttpSignature,
  type HttpSignatureOutcome,
  type HttpSignatureRequestSlice,
} from "./httpsig";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const PATH = "/api/v1/activitypub/user-id/2/inbox";
const KEY_ID_A = "https://remote.example/actors/bob#main-key";
const KEY_ID_B = "https://remote.example/actors/alice#main-key";

let pairA: CryptoKeyPair;
let pairB: CryptoKeyPair;
let pemA: string;

async function generateRsa3072(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair) || !("publicKey" in pair)) throw new Error("key generation did not yield a pair");
  return pair;
}

beforeAll(async () => {
  pairA = await generateRsa3072();
  pairB = await generateRsa3072();
  const spkiA = await crypto.subtle.exportKey("spki", pairA.publicKey);
  if (!(spkiA instanceof ArrayBuffer)) throw new Error("unexpected key export form");
  pemA = pemEncode("PUBLIC KEY", new Uint8Array(spkiA));
});

/** The fixture remote actor document (the Person shape the verifier reads). */
function actorDoc(keyId: string, publicKeyPem: string): string {
  const owner = keyId.split("#")[0] ?? keyId;
  return JSON.stringify({
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id: owner,
    type: "Person",
    publicKey: { id: keyId, owner, publicKeyPem },
  });
}

interface VectorOptions {
  body?: string;
  pathWithQuery?: string;
  /** The signed-header list; default the deleted client's PostHeaders. */
  headersList?: string[];
  /** Date header value; default the fixed NOW rendered RFC 1123 GMT. */
  date?: string;
  /** Omit the Date header from the request entirely. */
  omitDateHeader?: boolean;
  /** `null` omits the Digest header; default the true body digest. */
  digest?: string | null;
  algorithm?: string;
  keyId?: string;
  /** Raw signature override (garbage / wrong-length bytes). */
  signature?: string;
  /** Sign with pair B instead of pair A. */
  foreignSigner?: boolean;
  /** Serve the Authorization-scheme carriage instead of Signature:. */
  authorizationInstead?: boolean;
  /** Omit BOTH headers entirely (the unsigned-POST vector). */
  unsigned?: boolean;
  /** Pseudo-headers to sign — the matching parameters are appended. */
  pseudo?: Array<"created" | "expires">;
  /** A hand-built Signature header body — bypasses the signer entirely
   *  (vectors for headers a fixture signer cannot produce). */
  rawHeaderOverride?: string;
  /** Actor document overrides. */
  docBody?: string;
  docStatus?: number;
  fetchError?: boolean;
  /** Verify-stage clocks and caps. */
  now?: number;
  ttlSeconds?: number;
  maxDocumentBytes?: number;
}

/** Build + run one verify vector over the fixture actor. */
async function runVector(opts: VectorOptions = {}): Promise<HttpSignatureOutcome> {
  const body = new TextEncoder().encode(opts.body ?? "");
  const pathWithQuery = opts.pathWithQuery ?? PATH;
  const date = new Date(NOW).toUTCString();
  const headers: Record<string, string> = { "content-type": ACTIVITY_STREAMS_CONTENT_TYPE };
  if (opts.omitDateHeader !== true) headers["date"] = opts.date ?? date;
  if (opts.digest !== null) {
    headers["digest"] = opts.digest ?? (await computeSha256Digest(body));
  }
  const headerList =
    opts.headersList ?? (opts.digest === null ? ["(request-target)", "date"] : ["(request-target)", "date", "digest"]);
  const slice: HttpSignatureRequestSlice = {
    method: "POST",
    pathWithQuery,
    header: (name) => headers[name.toLowerCase()],
  };

  const createdValue = String(Math.floor(NOW / 1000));
  const expiresValue = String(Math.floor(NOW / 1000) + 60);
  const wantsCreated = opts.pseudo?.includes("created") === true;
  const wantsExpires = opts.pseudo?.includes("expires") === true;

  if (opts.rawHeaderOverride !== undefined) {
    headers["signature"] = opts.rawHeaderOverride;
  } else if (opts.unsigned !== true) {
    const signingString = buildSigningString(slice, headerList, {
      ...(wantsCreated ? { created: createdValue } : {}),
      ...(wantsExpires ? { expires: expiresValue } : {}),
    });
    if (signingString === null) throw new Error("fixture signing string failed");
    const signature =
      opts.signature ??
      (await signSigningString(signingString, (opts.foreignSigner ? pairB : pairA).privateKey));
    const header =
      renderSignatureHeader({
        keyId: opts.keyId ?? KEY_ID_A,
        algorithm: opts.algorithm ?? "rsa-sha256",
        headers: headerList,
        signature,
      }) +
      (wantsCreated ? `,created="${createdValue}"` : "") +
      (wantsExpires ? `,expires="${expiresValue}"` : "");
    headers[opts.authorizationInstead === true ? "authorization" : "signature"] =
      opts.authorizationInstead === true ? `Signature ${header}` : header;
  }

  const keyId = opts.keyId ?? KEY_ID_A;
  const doc = opts.docBody ?? actorDoc(keyId, pemA);
  const docStatus = opts.docStatus ?? 200;
  const fetchImpl: typeof fetch = opts.fetchError
    ? () => Promise.reject(new Error("network down"))
    : () => Promise.resolve(new Response(doc, { status: docStatus }));

  return verifyHttpSignature(
    { method: "POST", pathWithQuery, header: (name) => headers[name.toLowerCase()] },
    body,
    {
      fetchImpl,
      now: opts.now ?? NOW,
      ...(opts.ttlSeconds === undefined ? {} : { ttlSeconds: opts.ttlSeconds }),
      ...(opts.maxDocumentBytes === undefined ? {} : { maxDocumentBytes: opts.maxDocumentBytes }),
    },
  );
}

// ---------------------------------------------------------------------------
// The Signature parameter grammar
// ---------------------------------------------------------------------------

describe("parseSignatureParams — the draft parameter grammar", () => {
  it("parses the quoted four-param form with base64 padding inside the quotes", () => {
    const parsed = parseSignatureParams(
      'keyId="https://remote.example/actors/bob#main-key",algorithm="rsa-sha256",headers="(request-target) date digest",signature="aa==/bb=="',
    );
    expect(parsed?.keyId).toBe("https://remote.example/actors/bob#main-key");
    expect(parsed?.algorithm).toBe("rsa-sha256");
    expect(parsed?.headers).toEqual(["(request-target)", "date", "digest"]);
    expect(parsed?.signatureBase64).toBe("aa==/bb==");
  });

  it("tolerates unquoted values, whitespace, unknown params, and case-insensitive keys", () => {
    const parsed = parseSignatureParams(
      'KeyID = "https://a.example/x#k", signature = qw-er_ty , unknown="ignored", created="1700000000"',
    );
    expect(parsed?.keyId).toBe("https://a.example/x#k");
    expect(parsed?.signatureBase64).toBe("qw-er_ty");
    expect(parsed?.headers).toBeUndefined(); // absent → the draft's date default
    expect(parsed?.created).toBe("1700000000");
  });

  it("unescapes quoted-string escapes (the draft's sig-params grammar)", () => {
    const parsed = parseSignatureParams('keyId="https://a.example/x#k",signature="ab\\"cd\\\\ef"');
    expect(parsed?.signatureBase64).toBe('ab"cd\\ef');
  });

  it("missing keyId or signature → null (NewVerifier's error arm)", () => {
    expect(parseSignatureParams('algorithm="rsa-sha256"')).toBeNull();
    expect(parseSignatureParams('keyId="https://a.example/x#k"')).toBeNull();
    expect(parseSignatureParams("not-a-param-list")).toBeNull();
    expect(parseSignatureParams("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The canonical signing string
// ---------------------------------------------------------------------------

describe("buildSigningString — the canonical string (draft-cavage §2.3)", () => {
  const slice: HttpSignatureRequestSlice = {
    method: "POST",
    pathWithQuery: "/api/v1/activitypub/user-id/2/inbox",
    header: (name) => (name === "date" ? "Sat, 01 Nov 2026 12:00:00 GMT" : undefined),
  };

  it("renders one lowercase line per listed header, newline-joined", () => {
    const signing = buildSigningString(slice, ["(request-target)", "date"]);
    expect(signing).toBe(
      `(request-target): post /api/v1/activitypub/user-id/2/inbox\ndate: Sat, 01 Nov 2026 12:00:00 GMT`,
    );
  });

  it("a listed header absent from the request → null (the rejected arm)", () => {
    expect(buildSigningString(slice, ["host"])).toBeNull();
  });

  it("(created)/(expires) read the Signature parameters; absent → null", () => {
    const withParam = buildSigningString(slice, ["(created)", "(expires)"], {
      created: "1790000000",
      expires: "1790000060",
    });
    expect(withParam).toBe("(created): 1790000000\n(expires): 1790000060");
    expect(buildSigningString(slice, ["(created)"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The codec substrate
// ---------------------------------------------------------------------------

describe("the PEM + base64 codec", () => {
  it("pemEncode wraps at 64 chars with the Go armor lines; decode round-trips", () => {
    const der = new Uint8Array(200).map((_, i) => i % 251);
    const pem = pemEncode("PUBLIC KEY", der);
    expect(pem.startsWith("-----BEGIN PUBLIC KEY-----\n")).toBe(true);
    expect(pem.endsWith("-----END PUBLIC KEY-----\n")).toBe(true);
    const lines = pem.split("\n").slice(1, -2);
    expect(lines.every((line) => line.length <= 64)).toBe(true);
    expect(pemDecode(pem, "PUBLIC KEY")).toEqual(der);
  });

  it("pemDecode ignores whitespace inside the block, refuses wrong labels and garbage", () => {
    const der = new Uint8Array([1, 2, 3, 4, 5]);
    const pem = pemEncode("PUBLIC KEY", der);
    // A newline INSIDE the base64 body (offset 32 = past the BEGIN line).
    expect(pemDecode(`${pem.slice(0, 32)}\n${pem.slice(32)}`, "PUBLIC KEY")).toEqual(der);
    expect(pemDecode(pem, "PRIVATE KEY")).toBeNull();
    expect(pemDecode("-----BEGIN PUBLIC KEY-----\n!!!!\n-----END PUBLIC KEY-----", "PUBLIC KEY")).toBeNull();
    expect(pemDecode("hello", "PUBLIC KEY")).toBeNull();
  });

  it("base64 round-trips through the chunked binary encoder", () => {
    const bytes = new Uint8Array(70000).map((_, i) => (i * 7) % 256);
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
  });
});

// ---------------------------------------------------------------------------
// The bounded body read
// ---------------------------------------------------------------------------

describe("readBodyBounded — the streamed cap", () => {
  it("a null body reads as empty; an under-cap body reassembles exactly", async () => {
    const empty = await readBodyBounded(new Response(null), 1024);
    expect(empty).toEqual({ ok: true, body: new Uint8Array(0) });

    const body = "gitea federation inbox body";
    const read = await readBodyBounded(new Response(body), 1024);
    expect(read).toEqual({ ok: true, body: new TextEncoder().encode(body) });
  });

  it("an over-cap body short-circuits {ok:false} (the caller answers its size arm)", async () => {
    const big = "x".repeat(4096);
    const capped = await readBodyBounded(new Response(big), 1024);
    expect(capped).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// The verify vectors
// ---------------------------------------------------------------------------

describe("verifyHttpSignature — the fixed vectors (SPEC §7)", () => {
  it("a good signature over (request-target) date digest verifies", async () => {
    const outcome = await runVector({ body: '{"type":"Follow"}' });
    expect(outcome).toEqual({ kind: "verified", keyId: KEY_ID_A });
  });

  it("the Authorization-scheme carriage verifies identically", async () => {
    const outcome = await runVector({ authorizationInstead: true });
    expect(outcome).toEqual({ kind: "verified", keyId: KEY_ID_A });
  });

  it("the headers parameter is optional — the draft default signs date alone", async () => {
    const outcome = await runVector({ headersList: ["date"] });
    expect(outcome).toEqual({ kind: "verified", keyId: KEY_ID_A });
  });

  it("no Digest header → the body goes unattested (upstream verified only the signed list)", async () => {
    const outcome = await runVector({ digest: null });
    expect(outcome).toEqual({ kind: "verified", keyId: KEY_ID_A });
  });

  it("tampered body: the Digest header no longer matches → rejected", async () => {
    // The fixture signature is consistent with the (tampered) Digest
    // header — the mismatch is between that header and the actual body.
    const staleDigest = await computeSha256Digest(new TextEncoder().encode('{"type":"Follow"}'));
    const outcome = await runVector({
      body: '{"type":"Follow","tampered":true}',
      digest: staleDigest,
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("a Digest header without a sha-256 entry fails closed", async () => {
    const outcome = await runVector({ digest: "MD5=AAAA" });
    expect(outcome.kind).toBe("rejected");
  });

  it("stale Date past the deleted client's 60 s expiry → rejected (both directions)", async () => {
    const stale = await runVector({ now: NOW + 61_000 });
    expect(stale.kind).toBe("rejected");

    const future = await runVector({ now: NOW - 61_000 });
    expect(future.kind).toBe("rejected");
  });

  it("a Date inside the TTL verifies (boundary sanity)", async () => {
    const outcome = await runVector({ now: NOW + 60_000 });
    expect(outcome.kind).toBe("verified");
  });

  it("unparseable Date → rejected", async () => {
    const outcome = await runVector({ date: "not a date" });
    expect(outcome.kind).toBe("rejected");
  });

  it("a signed Date absent from the request → rejected (hand-built header)", async () => {
    const outcome = await runVector({
      omitDateHeader: true,
      digest: null,
      rawHeaderOverride: renderSignatureHeader({
        keyId: KEY_ID_A,
        algorithm: "rsa-sha256",
        headers: ["(request-target)", "date"],
        signature: "AAAA",
      }),
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("a signed header absent from the request → rejected (the v.Verify-stage failure)", async () => {
    // A fixture signer cannot sign a header it cannot read — hand-build
    // the header; the verifier's signing-string rebuild is what must fail.
    const outcome = await runVector({
      rawHeaderOverride: renderSignatureHeader({
        keyId: KEY_ID_A,
        algorithm: "rsa-sha256",
        headers: ["(request-target)", "date", "host"],
        signature: "AAAA",
      }),
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("wrong key: a foreign signer against the doc's key → rejected", async () => {
    const outcome = await runVector({ foreignSigner: true, keyId: KEY_ID_A });
    expect(outcome.kind).toBe("rejected");
  });

  it("the keyId must appear as the doc's publicKey.id — a mismatch is the error arm", async () => {
    const outcome = await runVector({ keyId: KEY_ID_A, docBody: actorDoc(KEY_ID_B, pemA) });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.reason).toContain("cannot find publicKey with id");
  });

  it("unknown keyId: a failed fetch fails closed — status and network arms", async () => {
    expect((await runVector({ docStatus: 404 })).kind).toBe("error");
    expect((await runVector({ fetchError: true })).kind).toBe("error");
  });

  it("a malformed actor document is the error arm (not-JSON, no publicKey, bad PEM)", async () => {
    expect((await runVector({ docBody: "<html>not json</html>" })).kind).toBe("error");
    expect(
      (await runVector({ docBody: JSON.stringify({ type: "Person", id: KEY_ID_A.split("#")[0] }) })).kind,
    ).toBe("error");
    expect(
      (await runVector({ docBody: actorDoc(KEY_ID_A, "-----BEGIN PUBLIC KEY-----\n!!!!\n-----END PUBLIC KEY-----") }))
        .kind,
    ).toBe("error");
  });

  it("an over-MaxSize actor document is the error arm (the fetch cap)", async () => {
    const outcome = await runVector({ maxDocumentBytes: 16 });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.reason).toContain("maximum size");
  });

  it("unsupported algorithm parameters → rejected (upstream ran Algorithms[0] only)", async () => {
    expect((await runVector({ algorithm: "rsa-sha512" })).kind).toBe("rejected");
    expect((await runVector({ algorithm: "hs2019" })).kind).toBe("rejected");
    expect((await runVector({ algorithm: "ed25519" })).kind).toBe("rejected");
  });

  it("a missing or unparseable Signature header is the upstream error arm (the unsigned POST)", async () => {
    expect((await runVector({ unsigned: true })).kind).toBe("error");
    expect((await runVector({ signature: "" })).kind).toBe("error");
  });

  it("a signature that is not base64 → rejected (the v.Verify-stage failure)", async () => {
    const outcome = await runVector({ signature: "!!!!" });
    expect(outcome.kind).toBe("rejected");
  });

  it("a wrong-length signature blob → rejected (subtle.verify throws)", async () => {
    const outcome = await runVector({ signature: base64Encode(new Uint8Array(10)) });
    expect(outcome.kind).toBe("rejected");
  });

  it("the (created) pseudo-header signs from the Signature parameter", async () => {
    const outcome = await runVector({
      headersList: ["(request-target)", "(created)"],
      digest: null,
      pseudo: ["created"],
    });
    expect(outcome.kind).toBe("verified");
  });

  it("a signed (created) pseudo-header with no matching parameter → rejected", async () => {
    const outcome = await runVector({
      headersList: ["(request-target)", "(created)"],
      digest: null,
      rawHeaderOverride: renderSignatureHeader({
        keyId: KEY_ID_A,
        algorithm: "rsa-sha256",
        headers: ["(request-target)", "(created)"],
        signature: "AAAA",
      }),
    });
    expect(outcome.kind).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// The signer seam (the deleted client.go canonical half — the battery's
// fixture generator and W-B5's future consumer)
// ---------------------------------------------------------------------------

describe("the signer seam", () => {
  it("renderSignatureHeader parses back to the same parameters", () => {
    const header = renderSignatureHeader({
      keyId: KEY_ID_A,
      algorithm: "rsa-sha256",
      headers: ["(request-target)", "date", "digest"],
      signature: "aa==",
    });
    expect(header).toBe(
      `keyId="${KEY_ID_A}",algorithm="rsa-sha256",headers="(request-target) date digest",signature="aa=="`,
    );
    const parsed = parseSignatureParams(header);
    expect(parsed?.keyId).toBe(KEY_ID_A);
    expect(parsed?.algorithm).toBe("rsa-sha256");
    expect(parsed?.headers).toEqual(["(request-target)", "date", "digest"]);
    expect(parsed?.signatureBase64).toBe("aa==");
  });

  it("signSigningString output verifies against the pair's public key", async () => {
    const signingString = "(request-target): post /inbox\ndate: Sat, 01 Nov 2026 12:00:00 GMT";
    const signature = await signSigningString(signingString, pairA.privateKey);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pairA.publicKey,
      base64Decode(signature),
      new TextEncoder().encode(signingString),
    );
    expect(verified).toBe(true);
  });
});
