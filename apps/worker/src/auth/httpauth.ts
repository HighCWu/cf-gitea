/**
 * `Authorization` header parsing — SPEC-0002 §2.2.
 *
 * Port of upstream `gitea/modules/auth/httpauth/httpauth.go` at the vendored
 * pin: case-insensitive schemes, exactly one space-separated value, the value
 * treated as an opaque string. Malformed headers parse as *no credentials*
 * (the caller falls back to the anonymous doer).
 */

export interface BasicAuth {
  username: string;
  password: string;
}

export interface BearerToken {
  token: string;
}

export interface ParsedAuthorizationHeader {
  basicAuth: BasicAuth | null;
  bearerToken: BearerToken | null;
}

/** ASCII case-insensitive equality (upstream `util.AsciiEqualFold`). */
function asciiEqualFold(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    const fold = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);
    if (fold(ca) !== fold(cb)) return false;
  }
  return true;
}

/**
 * Parse an `Authorization` header value. Returns `null` unless the header
 * has exactly two whitespace-separated fields and a known scheme
 * (`basic` with valid base64 `user:pass`, or `token`/`bearer`).
 */
export function parseAuthorizationHeader(header: string): ParsedAuthorizationHeader | null {
  const parts = header.split(/\s+/).filter((p) => p !== "");
  if (parts.length !== 2) return null;
  const [scheme, value] = parts as [string, string];

  if (asciiEqualFold(scheme, "basic")) {
    let decoded: string;
    try {
      // atob throws on characters outside the base64 alphabet; it is slightly
      // more lenient than Go's StdEncoding about padding, which only widens
      // the accepted client surface (test vectors stay padded/canonical).
      decoded = atob(value);
    } catch {
      return null;
    }
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return {
      basicAuth: { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) },
      bearerToken: null,
    };
  }

  if (asciiEqualFold(scheme, "token") || asciiEqualFold(scheme, "bearer")) {
    return { basicAuth: null, bearerToken: { token: value } };
  }

  return null;
}

/**
 * Extract the token value a credential carries, applying upstream Basic
 * token forms (`gitea/services/auth/basic.go:44–68`): the username is the
 * token when the password is empty or `x-oauth-basic`; otherwise the
 * password is. Real-password sign-in is deferred (SPEC-0002 §4.6.7) — the
 * returned candidate simply fails lookup for password attempts, which still
 * counts against failure limiting.
 */
export function basicAuthTokenCandidate(auth: BasicAuth): string {
  const isUsernameToken = auth.password === "" || auth.password === "x-oauth-basic";
  return isUsernameToken ? auth.username : auth.password;
}
