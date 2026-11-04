import type { MiddlewareHandler } from "hono";

import type { AuthInfo } from "../auth/auth-context";
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
