/**
 * Password validation policy — upstream modules/auth/password/password.go at
 * pin v29.0.0-dev-208-gfc493688 (the UpdateAuth validation arms, SPEC-0002
 * §6.2 change-password/admin-set rows) plus the Phase-C config surface
 * (census B-87, PW16): the policy is PARAMETERIZED (`PasswordPolicy`)
 * instead of hardwired, and `DEFAULT_PASSWORD_POLICY` carries upstream's
 * DEFAULT config so an unthreaded caller stays upstream-faithful.
 *
 * ## The default-complexity correction (B-87)
 *
 * The pre-B-87 module required one char of EVERY class by default, reading
 * password.go:77-96's "No valid character classes found; use all classes as
 * default" as the unset-config default. That phrase is setupComplexity's
 * INVALID-VALUES fallback branch: the actual load path seeds `["off"]` when
 * the key is unset (security.go:209-218 `if len(cfgdata) == 0 { cfgdata =
 * []string{"off"} }`), and setupComplexity's `values[0] != "off"` guard
 * then leaves `validChars` empty — IsComplexEnough passes WITHOUT checks.
 * app.example.ini:503 states it outright ("If left empty or no valid values
 * are specified, the default is off (no checking)"). Upstream's default
 * config therefore enforces NO complexity; the all-classes behavior fires
 * only when the key is SET with no valid class names. The census PW15 row
 * mis-derived this (recorded in the B-87 flip); DEFAULT_PASSWORD_POLICY now
 * carries the corrected upstream default and the knob
 * (api/config.ts passwordComplexityClasses) produces the armed shapes.
 *
 * The pwned check is default-OFF (`PASSWORD_CHECK_PWN`, MustBool(false) —
 * modules/auth/password/pwn.go:37); B-87 lands the REAL arm (`isPwned`, the
 * HIBP range API over outbound fetch — workerd's global fetch), gated by
 * the knob at the callers, with upstream's two failure shapes preserved.
 */

/** password.go:30-44 charComplexities — the four class names. */
export type PasswordComplexityClass = "lower" | "upper" | "digit" | "spec";

/**
 * The resolved password policy — upstream's `setting.MinPasswordLength` +
 * `setting.PasswordComplexity` + `setting.PasswordCheckPwn` as one value
 * (api/config.ts resolvePasswordPolicy builds it from the env). A caller
 * that cannot reach the env (the sibling-threaded arms pending their
 * owners' folds) passes nothing and gets `DEFAULT_PASSWORD_POLICY` —
 * upstream's default config, never the pre-B-87 hardwire.
 */
export interface PasswordPolicy {
  /** security.go:167 — MIN_PASSWORD_LENGTH, default 8. */
  minLength: number;
  /** security.go:209-218 — the required classes; EMPTY = no checking. */
  complexityClasses: readonly PasswordComplexityClass[];
  /** security.go:179 — PASSWORD_CHECK_PWN, default false. */
  checkPwned: boolean;
}

/**
 * Upstream's DEFAULT config as a policy: floor 8, NO complexity classes,
 * pwned off. Every password-set entry point under an untouched env must
 * behave exactly like upstream with no password keys in app.ini.
 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  complexityClasses: [],
  checkPwned: false,
};

/** security.go:167 — `MIN_LENGTH` MustInt(8); the upstream default floor. */
export const MIN_PASSWORD_LENGTH = 8;

/** password.go:30-44 charComplexities — the four classes verbatim. */
const PASSWORD_CLASSES: ReadonlyArray<{
  name: PasswordComplexityClass;
  validChars: string;
  message: string;
}> = [
  { name: "lower", validChars: "abcdefghijklmnopqrstuvwxyz", message: "At least one lowercase character" },
  { name: "upper", validChars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", message: "At least one uppercase character" },
  { name: "digit", validChars: "0123456789", message: "At least one digit" },
  {
    name: "spec",
    validChars: " !\"#$%&'()*+,-./:;<=>?@[\\]^_{|}~`",
    message: "At least one special character (punctuation, brackets, quotes, etc.)",
  },
];

/** The class table keyed for the readers (config.ts's
 *  passwordComplexityClasses) — upstream charComplexities' name set. */
export const ALL_PASSWORD_CLASSES: readonly PasswordComplexityClass[] = PASSWORD_CLASSES.map((c) => c.name);

/** The named-class guard the config reader filters with. */
export function isPasswordComplexityClass(name: string): name is PasswordComplexityClass {
  return PASSWORD_CLASSES.some((c) => c.name === name);
}

/** A required class's valid chars + locale message (BuildComplexityError's li rows). */
function passwordComplexityClass(name: PasswordComplexityClass): { validChars: string; message: string } {
  const entry = PASSWORD_CLASSES.find((c) => c.name === name)!;
  return { validChars: entry.validChars, message: entry.message };
}

/**
 * password.go:86-96 IsComplexEnough over an EXPLICIT class list (the knob's
 * resolution — empty list = upstream's unset default = no checking, always
 * true). Each required class must contribute at least one char.
 */
export function isComplexEnough(password: string, requiredClasses: readonly PasswordComplexityClass[]): boolean {
  if (requiredClasses.length === 0) return true;
  for (const name of requiredClasses) {
    if (!containsAny(passwordComplexityClass(name).validChars, password)) return false;
  }
  return true;
}

/**
 * password.go:125-136 BuildComplexityError, rendered as our flash text:
 * the "form.password_complexity" lead + one line per REQUIRED class (the
 * exact locale strings; the HTML <ul>/<li> wrapper becomes newlines — the
 * same plain-text adaptation the house flash convention uses). Upstream
 * renders the error only when the ladder already failed, so an empty
 * required set never reaches here.
 */
export function buildComplexityError(requiredClasses: readonly PasswordComplexityClass[]): string {
  return [
    "Password does not pass complexity requirements:",
    ...requiredClasses.map((name) => `- ${passwordComplexityClass(name).message}`),
  ].join("\n");
}

/** password.go:89-93 — Go's strings.ContainsAny per class. */
function containsAny(validChars: string, password: string): boolean {
  for (const ch of password) {
    if (validChars.includes(ch)) return true;
  }
  return false;
}

// --- The pwned arm (pwn.go — the PASSWORD_CHECK_PWN knob's real half) -------

/** Upstream `ErrIsPwned.Error()` (pwn.go:15) — the wire text on a hit. */
export const PASSWORD_PWNED_ERROR_TEXT = "password has been pwned";

/** Upstream `ErrIsPwnedRequest.Error()`'s prefix (pwn.go:26-28). */
const PWNED_REQUEST_FAILED_PREFIX = "using Have-I-Been-Pwned service failed";

/** pwn.go:44-46 — go-pwn's range endpoint (the wrapper calls
 *  `pwn.New().CheckPassword`, pwn.go:48; go-pwn's default URL). */
const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

/**
 * The discriminated result of `IsPwned` (pwn.go:37-51): `nil` = clean,
 * `ErrIsPwned` = present in breach corpora, `ErrIsPwnedRequest` = the
 * service call itself failed (upstream renders the password_pwned_err
 * posture at the web arms — NEVER a silent pass).
 */
export type PwnedResult =
  | { kind: "clean" }
  | { kind: "pwned" }
  | { kind: "request-failed"; message: string };

/**
 * pwn.go:37-51 IsPwned — the SHA-1 prefix range query against the
 * Have-I-Been-Pwned passwords API. SHA-1 upper-hex via crypto.subtle
 * (Web-standard API, workerd-native); the 5-char prefix goes on the URL,
 * the remaining 35 hex chars match the response's `SUFFIX:COUNT` lines
 * case-insensitively; count > 0 = pwned. A fetch/HTTP failure returns
 * `request-failed` carrying upstream's ErrIsPwnedRequest text — callers
 * render the recorded failure posture (auth.password_pwned_err), never
 * treat a failed check as a pass. `fetchImpl` is injectable for tests;
 * production rides the runtime global fetch.
 */
export async function isPwned(password: string, options?: { fetchImpl?: typeof fetch }): Promise<PwnedResult> {
  const doFetch = options?.fetchImpl ?? fetch;
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  const prefix = hex.slice(0, 5);
  const suffix = hex.slice(5);
  let res: Response;
  try {
    res = await doFetch(`${HIBP_RANGE_URL}${prefix}`, { headers: { "user-agent": "cf-gitea" } });
  } catch (error: unknown) {
    return {
      kind: "request-failed",
      message: `${PWNED_REQUEST_FAILED_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!res.ok) {
    return { kind: "request-failed", message: `${PWNED_REQUEST_FAILED_PREFIX}: unexpected HTTP status ${res.status}` };
  }
  const body = await res.text();
  for (const line of body.split("\n")) {
    const [lineSuffix, count] = line.trim().split(":");
    if (lineSuffix !== undefined && lineSuffix.toUpperCase() === suffix) {
      const parsed = Number.parseInt(count ?? "", 10);
      if (Number.isNaN(parsed) || parsed > 0) return { kind: "pwned" };
      return { kind: "clean" };
    }
  }
  return { kind: "clean" };
}
