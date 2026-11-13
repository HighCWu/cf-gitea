/**
 * The password-system config readers (census B-87, SPEC-0002 §6.5 Phase C)
 * — api/config.ts's six knobs over their upstream pins:
 *
 * - ENABLE_PASSWORD_SIGNIN_FORM  service.go:180 MustBool(true)
 * - ENABLE_BASIC_AUTHENTICATION  service.go:179 MustBool(true)
 * - PASSWORD_HASH_ALGO           security.go:175 MustString("") →
 *                                SetDefaultPasswordHashAlgorithm (hash/
 *                                setting.go:22-34,59-64; "" → pbkdf2 →
 *                                "pbkdf2$50000$50"); invalid = upstream's
 *                                boot log.Fatal → the executable=false flag
 * - MIN_PASSWORD_LENGTH          security.go:167 MustInt(8)
 * - PASSWORD_COMPLEXITY          security.go:209-218 Strings(","); unset →
 *                                ["off"] → NO checking (app.example.ini:503);
 *                                no-valid-class set → ALL classes
 *                                (password.go:84-85's fallback)
 * - PASSWORD_CHECK_PWN           security.go:179 MustBool(false)
 *
 * The bool/int parses mirror go-ini's MustBool/MustInt (trim+lowercase
 * 1/t/true, 0/f/false, strconv.ParseBool's set; Atoi) — upstream's OWN
 * parse, not the DEMO_MODE strict class.
 */

import { describe, expect, it } from "vitest";

import {
  configuredPasswordHashAlgo,
  enableBasicAuthentication,
  enablePasswordSignInForm,
  minPasswordLength,
  mustBoolConfig,
  mustIntConfig,
  passwordCheckPwnEnabled,
  passwordComplexityClasses,
  resolvePasswordPolicy,
  type PasswordConfigEnv,
} from "./config";

const env = (patch: Partial<PasswordConfigEnv>): PasswordConfigEnv => patch;

describe("mustBoolConfig (go-ini MustBool semantics)", () => {
  it("absent returns the MustBool default", () => {
    expect(mustBoolConfig(undefined, true)).toBe(true);
    expect(mustBoolConfig(undefined, false)).toBe(false);
  });

  it("the truthy set: 1/t/true, case- and padding-insensitive (go-ini parseBool + ParseBool)", () => {
    for (const raw of ["1", "t", "true", "TRUE", "True", " true "]) {
      expect(mustBoolConfig(raw, false)).toBe(true);
    }
  });

  it("the falsy set: 0/f/false; anything else falls back to the default", () => {
    for (const raw of ["0", "f", "false", "FALSE", "False", " false "]) {
      expect(mustBoolConfig(raw, true)).toBe(false);
    }
    expect(mustBoolConfig("garbage", true)).toBe(true);
    expect(mustBoolConfig("garbage", false)).toBe(false);
    expect(mustBoolConfig("yes", true)).toBe(true); // ParseBool rejects "yes" → default
  });
});

describe("mustIntConfig (go-ini MustInt semantics)", () => {
  it("absent/garbage returns the default (security.go:167's MustInt(8))", () => {
    expect(mustIntConfig(undefined, 8)).toBe(8);
    expect(mustIntConfig("", 8)).toBe(8);
    expect(mustIntConfig("abc", 8)).toBe(8);
  });

  it("Atoi over the raw value — including negatives and leading zeroes", () => {
    expect(mustIntConfig("16", 8)).toBe(16);
    expect(mustIntConfig("-4", 8)).toBe(-4);
    expect(mustIntConfig("08", 8)).toBe(8);
  });
});

describe("enablePasswordSignInForm / enableBasicAuthentication (MustBool(true) pair)", () => {
  it("defaults TRUE (service.go:179-180) — absent env is the upstream default", () => {
    expect(enablePasswordSignInForm(undefined)).toBe(true);
    expect(enableBasicAuthentication(undefined)).toBe(true);
    expect(enablePasswordSignInForm(env({}))).toBe(true);
    expect(enableBasicAuthentication(env({}))).toBe(true);
  });

  it("the off values: false/0/f (the go-ini parse), with garbage staying ON (MustBool default)", () => {
    expect(enablePasswordSignInForm(env({ ENABLE_PASSWORD_SIGNIN_FORM: "false" }))).toBe(false);
    expect(enableBasicAuthentication(env({ ENABLE_BASIC_AUTHENTICATION: "0" }))).toBe(false);
    expect(enablePasswordSignInForm(env({ ENABLE_PASSWORD_SIGNIN_FORM: "garbage" }))).toBe(true);
  });
});

describe("passwordCheckPwnEnabled (MustBool(false))", () => {
  it("defaults FALSE; arms on true/1", () => {
    expect(passwordCheckPwnEnabled(undefined)).toBe(false);
    expect(passwordCheckPwnEnabled(env({ PASSWORD_CHECK_PWN: "true" }))).toBe(true);
    expect(passwordCheckPwnEnabled(env({ PASSWORD_CHECK_PWN: "1" }))).toBe(true);
    expect(passwordCheckPwnEnabled(env({ PASSWORD_CHECK_PWN: "false" }))).toBe(false);
    expect(passwordCheckPwnEnabled(env({ PASSWORD_CHECK_PWN: "garbage" }))).toBe(false);
  });
});

describe("minPasswordLength (MustInt(8))", () => {
  it("defaults 8; a raised floor parses; garbage keeps 8", () => {
    expect(minPasswordLength(undefined)).toBe(8);
    expect(minPasswordLength(env({ MIN_PASSWORD_LENGTH: "16" }))).toBe(16);
    expect(minPasswordLength(env({ MIN_PASSWORD_LENGTH: "abc" }))).toBe(8);
  });
});

describe("passwordComplexityClasses (security.go:209-218 + password.go:63-83)", () => {
  it("unset/empty/off = NO checking — upstream's default (the B-87 correction)", () => {
    expect(passwordComplexityClasses(undefined)).toEqual([]);
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: "" }))).toEqual([]);
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: "   " }))).toEqual([]);
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: "off" }))).toEqual([]);
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: "OFF" }))).toEqual([]);
  });

  it("a valid subset arms exactly those classes; names lowercase + de-quoted like the loader", () => {
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: "lower" }))).toEqual(["lower"]);
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: "lower,upper" }))).toEqual(["lower", "upper"]);
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: ' "lower" ,DIGIT' }))).toEqual(["lower", "digit"]);
  });

  it("a set with NO valid class falls back to ALL four (password.go:84-85's own fallback branch)", () => {
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: "garbage" }))).toEqual([
      "lower",
      "upper",
      "digit",
      "spec",
    ]);
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: "foo,bar" }))).toEqual([
      "lower",
      "upper",
      "digit",
      "spec",
    ]);
  });

  it("empty segments are dropped before the fallback check (upstream's `name != ''` filter)", () => {
    // "," → zero non-empty names → the unset-shaped empty set → off.
    expect(passwordComplexityClasses(env({ PASSWORD_COMPLEXITY: ",,," }))).toEqual([]);
  });
});

describe("configuredPasswordHashAlgo (security.go:175 → hash/setting.go:22-64)", () => {
  it("absent/empty dealiases the default name to the configured spec", () => {
    expect(configuredPasswordHashAlgo(undefined)).toEqual({
      raw: "",
      specification: "pbkdf2$50000$50",
      executable: true,
    });
    expect(configuredPasswordHashAlgo(env({ PASSWORD_HASH_ALGO: "" }))).toMatchObject({
      specification: "pbkdf2$50000$50",
    });
  });

  it("alias names resolve through the transitive chain (setting.go:22-34)", () => {
    expect(configuredPasswordHashAlgo(env({ PASSWORD_HASH_ALGO: "pbkdf2_hi" }))).toMatchObject({
      raw: "pbkdf2_hi",
      specification: "pbkdf2$320000$50",
    });
    expect(configuredPasswordHashAlgo(env({ PASSWORD_HASH_ALGO: "pbkdf2" }))).toMatchObject({
      specification: "pbkdf2$50000$50",
    });
    expect(configuredPasswordHashAlgo(env({ PASSWORD_HASH_ALGO: "argon2" }))).toMatchObject({
      specification: "argon2$2$65536$8$50",
    });
  });

  it("executable=false is the boot-log.Fatal arm's Workers posture: unparseable specs and above-cap params (B-85)", () => {
    // scrypt: parseable upstream, NOT landed here → the controlled refusal.
    expect(configuredPasswordHashAlgo(env({ PASSWORD_HASH_ALGO: "scrypt" })).executable).toBe(false);
    // pbkdf2_hi's 320k iterations exceed the production deriveBits cap (workerd#1346).
    expect(configuredPasswordHashAlgo(env({ PASSWORD_HASH_ALGO: "pbkdf2_hi" })).executable).toBe(false);
    // garbage passes the alias chain through and fails the parser.
    expect(configuredPasswordHashAlgo(env({ PASSWORD_HASH_ALGO: "not-a-spec" })).executable).toBe(false);
  });
});

describe("resolvePasswordPolicy (the UpdateAuth ladder's one read)", () => {
  it("the default env resolves to upstream's DEFAULT config (floor 8, no classes, pwned off)", () => {
    expect(resolvePasswordPolicy(undefined)).toEqual({
      minLength: 8,
      complexityClasses: [],
      checkPwned: false,
    });
  });

  it("an armed env resolves every knob into the policy", () => {
    expect(
      resolvePasswordPolicy(
        env({
          MIN_PASSWORD_LENGTH: "12",
          PASSWORD_COMPLEXITY: "lower,digit",
          PASSWORD_CHECK_PWN: "true",
        }),
      ),
    ).toEqual({ minLength: 12, complexityClasses: ["lower", "digit"], checkPwned: true });
  });
});
