import type { MiddlewareHandler } from "hono";

import type { AuthInfo } from "../auth/auth-context";
import {
  ALL_PASSWORD_CLASSES,
  isPasswordComplexityClass,
  type PasswordComplexityClass,
  type PasswordPolicy,
} from "../auth/password-policy";
import { hashAlgorithmToSpec, parseStoredHashAlgo } from "../auth/password";
import type { ApiEnv } from "./env";

/**
 * Version string reported by `GET /version` (SPEC-0004 open question 1,
 * resolved: report the pinned upstream Gitea version — SDKs gate client
 * behavior on it).
 *
 * Value tracks the submodule pin, composed the way upstream's Makefile
 * composes GITEA_VERSION from `git describe --tags --always`:
 * `sed 's/-/+/' | sed 's/^v//'` (gitea/Makefile, "GITEA_VERSION" target).
 * Pinned describe output: `v29.0.0-dev-208-gfc49368845`. Re-pin = update this
 * one line (run `git -C gitea describe --tags --always` and apply the same
 * composition).
 */
export const SERVER_VERSION = "29.0.0+dev-208-gfc49368845";

/**
 * Path under the instance origin where the API documentation lives. Upstream
 * points every error body's `url` field here (`setting.API.SwaggerURL` =
 * AppURL + "api/swagger", gitea/modules/setting/api.go).
 */
export const SWAGGER_DOC_PATH = "/api/swagger";

/**
 * The require-sign-in-view instance flag (SPEC-0003 §2.4 row 6, census B-34):
 * upstream `[service] REQUIRE_SIGNIN_VIEW` → `Service.RequireSignInViewStrict`
 * (modules/setting/service.go:43,170). Strict polarity, the DEMO_MODE class:
 * ONLY the exact string "true" arms it; absent/anything else stays off, and
 * a default deployment is anonymous-readable exactly like upstream's
 * default (the setting is false in Gitea's app.ini default). Upstream arms:
 *
 *   1. git-HTTP — anonymous pulls 401 even on public repos (the
 *      `!RequireSignInViewStrict` gate over `canAnonymousPull`,
 *      routers/web/repo/githttp.go:132); overrides ACL rows 1 AND 4 (the
 *      upstream test pins the anonymous unit-read refusal,
 *      tests/integration/git_smart_http_test.go:186-188). Signed-in callers
 *      ride the unchanged permission ladder.
 *   2. API group — anonymous calls answered 403
 *      {"message": "Only signed in user is allowed to call APIs."}
 *      (verifyAuthWithOptionsAPI's SignInRequired arm, api.go:905-910,
 *      mounted over the whole group api.go:961) — a RAW {message} body, no
 *      `url` member, exactly like upstream's map literal.
 *   3. Web pages — the optSignIn middleware redirects anonymous viewers to
 *      the login page (web.go:354 + web.go:217-220 RedirectForLogin); ours
 *      refuses at the shared read gate (ui/repo-view.ts) into the tier's
 *      404-shell posture (SPEC-0008 §2.6: invisible repos 404, never a 401).
 *   4. Explore API — 401 "you must be signed in to search for users"
 *      (api.go:315-321): no /explore surface is served here, N/A.
 *   5. Packages — anonymous package access refused
 *      (services/context/package.go:120, container :124-158): recorded in
 *      the census B-34 disposition for the packages owner.
 *
 * The env slice rides structurally (the DemoQuotaEnv posture) so tests can
 * drive unset/armed without the generated Env.
 */
export type RequireSignInViewEnv = { REQUIRE_SIGNIN_VIEW?: string };

export function requireSignInViewEnabled(env: RequireSignInViewEnv | undefined): boolean {
  return env?.REQUIRE_SIGNIN_VIEW === "true";
}

/**
 * Arm 2 — the API-group gate: mounted ONCE at the top of `createApiRouter`
 * (after the tree resolves auth at the worker level; reads the same
 * `c.get("auth")` context the scope gate does). Anonymous → upstream's exact
 * 403 body; the response is returned raw (not thrown) because the body is a
 * bare `{message}` map WITHOUT the `url` member the shared envelope adds
 * (upstream writes a map literal, api.go:908-910 — the same raw-body
 * precedent as the generate route's owner-miss 404).
 */
export function requireSignInViewApiGate(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    // The undefined-env arm is the standalone-router posture (route tests
    // drive `router.request()` without bindings) — the same no-op class as
    // the unresolved auth below; production always carries the worker env.
    if (!requireSignInViewEnabled(c.env)) {
      await next();
      return;
    }
    const auth: AuthInfo | undefined = c.get("auth");
    // Standalone-router usage (route tests mount createApiRouter without the
    // worker-level resolveAuth) has no resolved identity to consult — the
    // apiScopeGate no-op posture; production always resolves first.
    if (auth === undefined) {
      await next();
      return;
    }
    if (auth.user === null) {
      return c.json({ message: "Only signed in user is allowed to call APIs." }, 403);
    }
    await next();
  };
}

// --- Password-system Phase-C config knobs (census B-87, SPEC-0002 §6.5) -----
//
// The six upstream password/auth toggles over wrangler vars, each with the
// upstream default (ADR-0008: behavioral equivalence at the default config).
// Upstream resolves these once at boot (`log.Fatal` on a bad hash algo,
// security.go:176-178); Workers config is per-request env, so the readers
// resolve per call and the boot-death arms become the documented refusal
// postures at the consumers. The env slice is STRUCTURAL (the
// RequireSignInViewEnv posture) so tests drive unset/armed without the
// generated Env.

/**
 * The structural env slice the password-knob readers accept — ALL members
 * optional (the exact RequireSignInViewEnv posture): any generated Env or
 * narrowed service env (FirstRunEnv et al.) assigns, and tests drive
 * unset/armed with bare object literals.
 */
export type PasswordConfigEnv = {
  /** `[service] ENABLE_PASSWORD_SIGNIN_FORM` (service.go:180, MustBool(true)). */
  ENABLE_PASSWORD_SIGNIN_FORM?: string;
  /** `[service] ENABLE_BASIC_AUTHENTICATION` (service.go:179, MustBool(true)). */
  ENABLE_BASIC_AUTHENTICATION?: string;
  /** `[security] PASSWORD_HASH_ALGO` (security.go:175, MustString("")). */
  PASSWORD_HASH_ALGO?: string;
  /** `[security] MIN_PASSWORD_LENGTH` (security.go:167, MustInt(8)). */
  MIN_PASSWORD_LENGTH?: string;
  /** `[security] PASSWORD_COMPLEXITY` (security.go:209, Strings(",")). */
  PASSWORD_COMPLEXITY?: string;
  /** `[security] PASSWORD_CHECK_PWN` (security.go:179, MustBool(false)). */
  PASSWORD_CHECK_PWN?: string;
};

/**
 * go-ini's `Key.MustBool(default)` parse: trim + lowercase, then the
 * "1"/"t"/"true" and "0"/"f"/"false" arms, then strconv.ParseBool's set —
 * anything else returns the MustBool default (go-ini parseBool.go). This is
 * UPSTREAM's own parse, not the DEMO_MODE strict class: upstream accepts
 * "1"/"TRUE"/" True " alike, and the default is what an unparsable value
 * yields.
 */
export function mustBoolConfig(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const raw = value.trim().toLowerCase();
  if (raw === "1" || raw === "t" || raw === "true") return true;
  if (raw === "0" || raw === "f" || raw === "false") return false;
  return defaultValue;
}

/**
 * go-ini's `Key.MustInt(default)` parse: strconv.Atoi over the raw value —
 * leading/trailing spaces fail upstream's parse too, and any failure
 * returns the default (security.go:167's MustInt(8)).
 */
export function mustIntConfig(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * `[service] ENABLE_PASSWORD_SIGNIN_FORM` → `Service.EnablePasswordSignInForm`
 * (service.go:180, default TRUE). Off hides the web sign-in form
 * (signin_inner.tmpl:13-49 wraps the whole `<form>` — user_name, password,
 * remember, submit and the forgot-password link) and 403s the POST arm
 * (auth.go:293-295); external-auth buttons render without the "or" divider
 * (signin_inner.tmpl:51's `and`).
 */
export function enablePasswordSignInForm(env: PasswordConfigEnv | undefined): boolean {
  return mustBoolConfig(env?.ENABLE_PASSWORD_SIGNIN_FORM, true);
}

/**
 * `[service] ENABLE_BASIC_AUTHENTICATION` → `Service.EnableBasicAuth`
 * (service.go:179, default TRUE). Off makes the Basic PASSWORD method NOT
 * APPLICABLE (basic.go:139-141 `return nil, nil`): the request proceeds
 * ANONYMOUS — the endpoint's own auth requirement answers, never the
 * generic invalid-credential 401. Basic-carried TOKENS verify before the
 * gate (basic.go:134-137's VerifyAuthToken arm) and are unaffected.
 */
export function enableBasicAuthentication(env: PasswordConfigEnv | undefined): boolean {
  return mustBoolConfig(env?.ENABLE_BASIC_AUTHENTICATION, true);
}

/**
 * The resolved PASSWORD_HASH_ALGO: the raw var, its dealiased full
 * specification (security.go:175 stores the dealiased spec —
 * hashAlgorithmToSpec's chain, setting.go:22-34, "" → the "pbkdf2" default
 * name → "pbkdf2$50000$50"), and whether the runtime can EXECUTE it
 * (upstream boots `log.Fatal` on an unparseable spec, security.go:176-178;
 * Workers has no boot hook, so `executable=false` is the flag consumers
 * check — the recorded controlled-refusal posture, never a silent
 * mismatch). Execution is judged by the SAME parser stored rows go through
 * (parseStoredHashAlgo), which folds the B-85 production caps (workerd
 * deriveBits/argon2 ceilings) into the answer.
 */
export function configuredPasswordHashAlgo(
  env: PasswordConfigEnv | undefined,
): { raw: string; specification: string; executable: boolean } {
  const raw = env?.PASSWORD_HASH_ALGO ?? "";
  const specification = hashAlgorithmToSpec(raw);
  let executable = true;
  try {
    parseStoredHashAlgo(specification);
  } catch {
    executable = false;
  }
  return { raw, specification, executable };
}

/** `[security] MIN_PASSWORD_LENGTH` (security.go:167, default 8). */
export function minPasswordLength(env: PasswordConfigEnv | undefined): number {
  return mustIntConfig(env?.MIN_PASSWORD_LENGTH, 8);
}

/**
 * `[security] PASSWORD_COMPLEXITY` → the required character classes
 * (security.go:209-218 + password.go:63-83): unset/empty/"off" → NONE (the
 * upstream default — app.example.ini:503 "If left empty or no valid values
 * are specified, the default is off (no checking)"); a set with at least
 * one valid class → those classes only; a set with NO valid class → ALL
 * four (setupComplexity's own fallback, password.go:84-85). The class
 * names are lowercase-trimmed like upstream's loader.
 */
export function passwordComplexityClasses(env: PasswordConfigEnv | undefined): PasswordComplexityClass[] {
  const raw = env?.PASSWORD_COMPLEXITY;
  if (raw === undefined || raw.trim() === "") return [];
  const names = raw
    .split(",")
    .map((name) => name.trim().toLowerCase().replaceAll('"', ""))
    .filter((name) => name !== "");
  if (names.length === 0 || (names.length === 1 && names[0] === "off")) return [];
  const valid = names.filter((name) => isPasswordComplexityClass(name));
  if (valid.length === 0) return [...ALL_PASSWORD_CLASSES];
  return valid;
}

/** `[security] PASSWORD_CHECK_PWN` (security.go:179, default FALSE). */
export function passwordCheckPwnEnabled(env: PasswordConfigEnv | undefined): boolean {
  return mustBoolConfig(env?.PASSWORD_CHECK_PWN, false);
}

/**
 * The whole password policy in one read — the shape the UpdateAuth ladder
 * consumers take (upstream reads `setting.MinPasswordLength`,
 * `IsComplexEnough` over `setting.PasswordComplexity` and `IsPwned` over
 * `setting.PasswordCheckPwn` at the same arms, update.go:256-264). The
 * complexity classes are resolved eagerly so callers can pass the value
 * down without the env.
 */
export function resolvePasswordPolicy(env: PasswordConfigEnv | undefined): PasswordPolicy {
  return {
    minLength: minPasswordLength(env),
    complexityClasses: passwordComplexityClasses(env),
    checkPwned: passwordCheckPwnEnabled(env),
  };
}
