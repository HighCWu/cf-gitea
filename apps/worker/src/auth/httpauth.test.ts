/**
 * Credential parsing tests — ported from upstream
 * `gitea/modules/auth/httpauth/httpauth_test.go` at the vendored pin
 * (SPEC-0002 §5), plus the Basic token-form rules from
 * `gitea/services/auth/basic.go:44–68`.
 */

import { describe, expect, it } from "vitest";

import { basicAuthTokenCandidate, parseAuthorizationHeader } from "./httpauth";

const b64 = (value: string): string => btoa(value);

describe("parseAuthorizationHeader (upstream case table)", () => {
  const cases: Array<{ header: string; ok: boolean; basic?: [string, string]; bearer?: string }> = [
    { header: "", ok: false },
    { header: "?", ok: false },
    { header: "foo", ok: false },
    { header: "any value", ok: false },

    { header: "Basic ?", ok: false },
    { header: `Basic ${b64("foo")}`, ok: false },
    { header: `Basic ${b64("foo:bar")}`, ok: true, basic: ["foo", "bar"] },
    { header: `basic ${b64("foo:bar")}`, ok: true, basic: ["foo", "bar"] },

    { header: "token value", ok: true, bearer: "value" },
    { header: "Token value", ok: true, bearer: "value" },
    { header: "bearer value", ok: true, bearer: "value" },
    { header: "Bearer value", ok: true, bearer: "value" },
    { header: "Bearer wrong value", ok: false },
  ];

  for (const { header, ok, basic, bearer } of cases) {
    it(`parses ${JSON.stringify(header)}`, () => {
      const parsed = parseAuthorizationHeader(header);
      if (!ok) {
        expect(parsed).toBeNull();
        return;
      }
      expect(parsed).not.toBeNull();
      expect(parsed?.basicAuth).toEqual(basic === undefined ? null : { username: basic[0], password: basic[1] });
      expect(parsed?.bearerToken).toEqual(bearer === undefined ? null : { token: bearer });
    });
  }

  it("splits Basic credentials on the FIRST colon only", () => {
    const parsed = parseAuthorizationHeader(`Basic ${b64("user:pass:word")}`);
    expect(parsed?.basicAuth).toEqual({ username: "user", password: "pass:word" });
  });

  it("keeps token values verbatim including dots (future OAuth2 JWTs)", () => {
    const parsed = parseAuthorizationHeader("Bearer a.b.c");
    expect(parsed?.bearerToken?.token).toBe("a.b.c");
  });
});

describe("basicAuthTokenCandidate (services/auth/basic.go:44–68)", () => {
  it("treats the username as token when the password is empty", () => {
    expect(basicAuthTokenCandidate({ username: "cfg_abc", password: "" })).toBe("cfg_abc");
  });

  it("treats the username as token when the password is x-oauth-basic", () => {
    expect(basicAuthTokenCandidate({ username: "cfg_abc", password: "x-oauth-basic" })).toBe("cfg_abc");
  });

  it("treats the password as token otherwise", () => {
    expect(basicAuthTokenCandidate({ username: "alice", password: "cfg_abc" })).toBe("cfg_abc");
  });
});
