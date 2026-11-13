/**
 * The password POLICY units (census B-87 — the parameterized PasswordPolicy
 * half of password-policy.ts; the readers that build the policy live in
 * api/config.test.ts). This battery split out of password.test.ts's policy
 * pins because the parameterization REPLACED the pre-B-87 all-classes
 * hardwire: DEFAULT_PASSWORD_POLICY carries upstream's corrected default
 * (NO complexity checking — security.go:209-18 seeds "off" when the key is
 * unset; app.example.ini:503 states it) and the armed shapes take an
 * explicit class list. The pwned arm (pwn.go:37-51) pins with an injected
 * fetch — no network in tests, ever.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_PASSWORD_CLASSES,
  buildComplexityError,
  DEFAULT_PASSWORD_POLICY,
  isComplexEnough,
  isPasswordComplexityClass,
  isPwned,
  PASSWORD_PWNED_ERROR_TEXT,
  type PasswordPolicy,
} from "./password-policy";
import { validateNewPassword, pwnedArmMessage, PASSWORD_PWNED_MESSAGE } from "../services/user-accounts";

const policy = (patch: Partial<PasswordPolicy>): PasswordPolicy => ({ ...DEFAULT_PASSWORD_POLICY, ...patch });

describe("DEFAULT_PASSWORD_POLICY (upstream's default config)", () => {
  it("floor 8, NO complexity classes, pwned off", () => {
    expect(DEFAULT_PASSWORD_POLICY).toEqual({ minLength: 8, complexityClasses: [], checkPwned: false });
  });

  it("the class table matches upstream's charComplexities name set (password.go:30-44)", () => {
    expect(ALL_PASSWORD_CLASSES).toEqual(["lower", "upper", "digit", "spec"]);
    expect(isPasswordComplexityClass("lower")).toBe(true);
    expect(isPasswordComplexityClass("nope")).toBe(false);
  });
});

describe("isComplexEnough over an explicit class list (password.go:86-96)", () => {
  it("an empty list = no checking (the unset-config default)", () => {
    expect(isComplexEnough("", [])).toBe(true);
    expect(isComplexEnough("abc", [])).toBe(true);
  });

  it("each required class must contribute at least one char", () => {
    expect(isComplexEnough("abc", ["lower"])).toBe(true);
    expect(isComplexEnough("ABC", ["lower"])).toBe(false);
    expect(isComplexEnough("aB", ["lower", "upper"])).toBe(true);
    expect(isComplexEnough("ab", ["lower", "upper"])).toBe(false);
    expect(isComplexEnough("aB1!c", ["lower", "upper", "digit", "spec"])).toBe(true);
    expect(isComplexEnough("aB1c", ["lower", "upper", "digit", "spec"])).toBe(false); // no spec char
  });
});

describe("buildComplexityError over an explicit list (password.go:125-136, the plain-text adaptation)", () => {
  it("the lead + one line per required class, in class order", () => {
    expect(buildComplexityError(["upper", "digit"])).toBe(
      [
        "Password does not pass complexity requirements:",
        "- At least one uppercase character",
        "- At least one digit",
      ].join("\n"),
    );
    expect(buildComplexityError([...ALL_PASSWORD_CLASSES])).toContain(
      "- At least one special character (punctuation, brackets, quotes, etc.)",
    );
  });
});

describe("validateNewPassword (user-accounts.ts's sync ladder half over the policy)", () => {
  it("the min-length arm uses the policy floor", () => {
    expect(validateNewPassword("a")).toBe("Password length cannot be less than 8 characters.");
    expect(validateNewPassword("a", policy({ minLength: 4 }))).toBe(
      "Password length cannot be less than 4 characters.",
    );
    expect(validateNewPassword("abcd", policy({ minLength: 4 }))).toBeNull();
  });

  it("the DEFAULT policy does NOT reject a weak single-class password (the B-87 default flip)", () => {
    expect(validateNewPassword("alllowercase123")).toBeNull();
  });

  it("an armed all-classes policy rejects with the complexity text", () => {
    const armed = policy({ complexityClasses: [...ALL_PASSWORD_CLASSES] });
    const message = validateNewPassword("alllowercase123", armed);
    expect(message).toContain("Password does not pass complexity requirements:");
    expect(validateNewPassword("Fresh-1a", armed)).toBeNull();
  });
});

describe("isPwned (pwn.go:37-51 — the HIBP range API, fetch injected)", () => {
  /** The response body whose ONLY served suffix belongs to `password`. */
  const rangeBodyFor = async (password: string, count = 42): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    return `${hex.slice(5)}:${count}`;
  };

  const fakeFetch = (body: string, status = 200, seen: { url?: string } = {}): typeof fetch =>
    (input: RequestInfo | URL) => {
      seen.url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(new Response(body, { status }));
    };

  it("a served suffix with count > 0 answers pwned", async () => {
    const seen: { url?: string } = {};
    const body = await rangeBodyFor("Pwned-Pass-1");
    const result = await isPwned("Pwned-Pass-1", { fetchImpl: fakeFetch(body, 200, seen) });
    expect(result).toEqual({ kind: "pwned" });
    // The 5-char prefix rides the URL (pwn.go:44-46's range shape); the
    // remaining 35 chars never leave the client.
    expect(seen.url).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[A-F0-9]{5}$/);
  });

  it("a zero-count line answers clean (pwn.go:47-50's count>0 guard)", async () => {
    const result = await isPwned("Clean-Pass-1", { fetchImpl: fakeFetch(await rangeBodyFor("Clean-Pass-1", 0)) });
    expect(result).toEqual({ kind: "clean" });
  });

  it("a suffix miss answers clean", async () => {
    const result = await isPwned("Clean-Pass-2", {
      fetchImpl: fakeFetch("ABCDEF0123456789ABCDEF0123456789ABCDEF01:5\nBBBBBB0123456789ABCDEF0123456789ABCDEF01:9\n"),
    });
    expect(result).toEqual({ kind: "clean" });
  });

  it("suffix matching is case-insensitive (the API serves uppercase; the digest is uppercased too)", async () => {
    const body = (await rangeBodyFor("Mixed-Case-1")).toLowerCase();
    const result = await isPwned("Mixed-Case-1", { fetchImpl: fakeFetch(body) });
    expect(result).toEqual({ kind: "pwned" });
  });

  it("a network failure answers request-failed carrying ErrIsPwnedRequest's text (pwn.go:26-28)", async () => {
    const failing: typeof fetch = () => Promise.reject(new Error("dns timeout"));
    const result = await isPwned("Whatever-1", { fetchImpl: failing });
    expect(result).toEqual({ kind: "request-failed", message: "using Have-I-Been-Pwned service failed: dns timeout" });
  });

  it("a non-200 answers request-failed too (never a silent pass)", async () => {
    const result = await isPwned("Whatever-2", { fetchImpl: fakeFetch("upstream exploded", 503) });
    expect(result).toEqual({
      kind: "request-failed",
      message: "using Have-I-Been-Pwned service failed: unexpected HTTP status 503",
    });
  });

  it("the raw ErrIsPwned wire text for the API edit arm (admin/user.go:220-221's err.Error())", () => {
    expect(PASSWORD_PWNED_ERROR_TEXT).toBe("password has been pwned");
  });
});

describe("pwnedArmMessage (the WEB arms' flash texts — account.go:88-90 / password.go:216-219)", () => {
  it("clean continues the ladder (null)", () => {
    expect(pwnedArmMessage({ kind: "clean" })).toBeNull();
  });

  it("pwned renders auth.password_pwned with the anchor reduced to the bare URL (the house plain-text flash)", () => {
    expect(pwnedArmMessage({ kind: "pwned" })).toBe(PASSWORD_PWNED_MESSAGE);
    expect(PASSWORD_PWNED_MESSAGE).toContain("https://haveibeenpwned.com/Passwords");
    expect(PASSWORD_PWNED_MESSAGE).not.toContain("<a");
  });

  it("a request failure renders auth.password_pwned_err — never a silent pass", () => {
    expect(pwnedArmMessage({ kind: "request-failed", message: "whatever" })).toBe(
      "Could not complete request to HaveIBeenPwned",
    );
  });
});
