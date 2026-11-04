/**
 * Password validation policy — upstream modules/auth/password/password.go at
 * pin v29.0.0-dev-208-gfc493688 (the UpdateAuth validation arms, SPEC-0002
 * §6.2 change-password/admin-set rows).
 *
 * Upstream's default config (no `PASSWORD_COMPLEXITY` in app.ini →
 * `setupComplexity([])` → "No valid character classes found; use all classes
 * as default") requires one char of EVERY class (password.go:86-96
 * IsComplexEnough). The pwned check is default-OFF
 * (`PASSWORD_CHECK_PWNED` MustBool(false) — modules/auth/password/pwn.go:37)
 * and needs outbound HIBP; Phase A keeps it off (the config surface is
 * Phase C) — recorded as the upstream-default posture, not an omission.
 */

/** security.go:167 — `MIN_LENGTH` MustInt(8). */
export const MIN_PASSWORD_LENGTH = 8;

/** password.go:30-44 charComplexities — the four classes verbatim. */
const PASSWORD_CLASSES: ReadonlyArray<{ name: string; validChars: string; message: string }> = [
  { name: "lower", validChars: "abcdefghijklmnopqrstuvwxyz", message: "At least one lowercase character" },
  { name: "upper", validChars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", message: "At least one uppercase character" },
  { name: "digit", validChars: "0123456789", message: "At least one digit" },
  {
    name: "spec",
    validChars: " !\"#$%&'()*+,-./:;<=>?@[\\]^_{|}~`",
    message: "At least one special character (punctuation, brackets, quotes, etc.)",
  },
];

/** password.go:86-96 IsComplexEnough under the all-classes default. */
export function isComplexEnough(password: string): boolean {
  for (const complexity of PASSWORD_CLASSES) {
    if (!containsAny(complexity.validChars, password)) return false;
  }
  return true;
}

/**
 * password.go:125-136 BuildComplexityError, rendered as our flash text:
 * the "form.password_complexity" lead + one line per required class (the
 * exact locale strings; the HTML <ul>/<li> wrapper becomes newlines — the
 * same plain-text adaptation the house flash convention uses).
 */
export function buildComplexityError(): string {
  return ["Password does not pass complexity requirements:", ...PASSWORD_CLASSES.map((c) => `- ${c.message}`)].join(
    "\n",
  );
}

/** password.go:89-93 — Go's strings.ContainsAny per class. */
function containsAny(validChars: string, password: string): boolean {
  for (const ch of password) {
    if (validChars.includes(ch)) return true;
  }
  return false;
}
