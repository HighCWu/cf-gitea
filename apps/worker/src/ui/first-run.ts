/**
 * First-run routes (SPEC-0010 §6 amendment, 2026-10-28): the ONE-SHOT
 * admin-init window and the ALLOW_SIGNUP-gated registration — the two
 * web surfaces that make a fresh deployment usable in one browser step.
 *
 *   GET  /install        — the login page + Administrator Account Settings
 *                          panel (instances with no HUMAN user yet — the
 *                          migration-seeded system service principals don't
 *                          count, see the service gate; initialized
 *                          instances 303 to `/`)
 *   POST /install        — the atomic first-admin creation; the winner is
 *                          signed in immediately (session mint + Set-Cookie,
 *                          upstream install.go:479–490's auto-login), the
 *                          race loser re-renders with the clear
 *                          already-initialized verdict
 *   GET  /user/sign_up   — the registration page (upstream web.go:597
 *                          `m.Get("/user/sign_up", auth.SignUp)` — the
 *                          upstream-faithful path shape; our web login
 *                          similarly lives at its own top-level route)
 *   POST /user/sign_up   — the registration submit (auth.SignUpPost: create
 *                          + handleSignIn auto-login, auth.go:632)
 *
 * Upstream posture: the install family is upstream `r.Get/r.Post("/", …)`
 * (routers/install/routes.go:30–31) — cf-gitea claims `/install` instead of
 * `/` because the app home is a landed surface (documented divergence); the
 * signup family keeps upstream's exact `/user/sign_up` paths. The gate is
 * the `ALLOW_SIGNUP` var (default FALSE — upstream's inverted
 * DISABLE_REGISTRATION default, setting/service.go:148): pages and routes
 * answer 404 while closed, exactly like upstream's unregistered route shape.
 *
 * The write-surfaces carry the §2.8 layer-2 Origin check (sameOriginGuard,
 * reused from session.ts), render failures inline at 200 (the §2.2
 * posture), and mint web sessions through the session service's exported
 * seams — sessions never authorize /api/v1 or git-HTTP (§2.9).
 *
 * ---------------------------------------------------------------------------
 * MOUNTED at df1e362 — `src/index.ts` routes the router:
 *
 *   app.route("/", firstRunRouter);
 *
 * BEFORE the uiRouter (9d77172's correction of this note's original
 * "order immaterial" claim: /user/sign_up is two segments and Hono's
 * RegExpRouter gives the dynamic /:owner/:repo pair precedence over a
 * static registered in a LATER-mounted router — /login survived only by
 * being single-segment). The sessionRouter mounts after (single-segment
 * /login + /logout, never repo-scoped — SPEC-0010 §2.1). The OPTIONAL
 * login-page integration (the init form + register link on GET /login
 * proper) is MOUNTED too (the session router's renderLoginPage call —
 * the mount record in src/ui/pages/login.tsx); GET /install still
 * renders the identical page.
 * ---------------------------------------------------------------------------
 */

import { Hono, type Context } from "hono";

import { assetsBinding, assetsNotBuilt } from "./index";
import { AssetBuildError, loadManifest } from "./manifest";
import {
  renderInstallPage,
  renderSignUpPage,
  signUpLocale,
} from "./pages/first-run";
import { loginFirstRunLocale } from "./pages/login";
import { demoModeEnabled } from "../services/demo-sweep";
import {
  allowSignup,
  initWindowOpen,
  initializeAdminUser,
  registerUser,
  type AccountForm,
  type FirstRunEnv,
} from "../services/user-accounts";
import {
  mintSession,
  sameOriginGuard,
  sessionCookieValue,
  sessionSetCookie,
  verifySession,
} from "./session";
import { renderNotFound } from "./render";
import { shellAssetsFromManifest, type UiContext } from "./ui-context";

type RouteContext = Context<{ Bindings: FirstRunEnv }>;

// ---------------------------------------------------------------------------
// Shared route plumbing (the session.ts patterns, verbatim shapes)
// ---------------------------------------------------------------------------

/** `ctx.waitUntil` where an execution context exists; detached otherwise
 *  (router.fetch-style test invocations — the backgroundSink convention). */
function backgroundSink(c: RouteContext): (promise: Promise<unknown>) => void {
  try {
    const ctx = c.executionCtx;
    return (promise) => {
      ctx.waitUntil(promise);
    };
  } catch {
    return (promise) => void promise.catch(() => {});
  }
}

/** 303 See Other — upstream's redirect default (base.go:157). */
function seeOther(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 303, headers });
}

const MAX_FORM_BYTES = 8192;

/** Parse the `application/x-www-form-urlencoded` body into the named
 *  string fields (bounded by the content-length cap — the login-form
 *  convention; a missing/oversized/malformed body parses as empty). */
async function parseAccountForm(
  req: Request,
): Promise<{ user_name: string; admin_name: string; email: string; admin_passwd: string; password: string; retype: string }> {
  const empty = { user_name: "", admin_name: "", email: "", admin_passwd: "", password: "", retype: "" };
  const contentType = req.headers.get("content-type") ?? "";
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!contentType.startsWith("application/x-www-form-urlencoded") || length > MAX_FORM_BYTES) {
    return empty;
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
  } catch {
    return empty;
  }
  return {
    user_name: params.get("user_name") ?? "",
    admin_name: params.get("admin_name") ?? "",
    email: params.get("email") ?? "",
    admin_passwd: params.get("admin_passwd") ?? "",
    password: params.get("password") ?? "",
    retype: params.get("retype") ?? "",
  };
}

/** Assemble the anonymous page context the way the session router does
 *  (§2.3.4: a missing manifest fails fast with the 503 first). */
async function pageContext(
  c: RouteContext,
): Promise<{ ctx: UiContext } | { response: Response }> {
  const url = new URL(c.req.url);
  try {
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    return { ctx: { viewer: { kind: "anonymous" }, origin: url.origin, demoMode: demoModeEnabled(c.env), assets: shellAssetsFromManifest(manifest) } };
  } catch (error) {
    if (error instanceof AssetBuildError) return { response: assetsNotBuilt(error) };
    throw error;
  }
}

/** The signed-in short-circuit: a valid session 303s to `/` (carrying a
 *  rotation cookie if one was minted) — a signed-in browser has no business
 *  on the first-run surfaces, and an anonymous render of them would show
 *  the anonymous navbar to an authenticated principal. Upstream divergence:
 *  upstream renders /user/sign_up to signed-in users; ours redirects. */
async function redirectIfSignedIn(c: RouteContext): Promise<Response | null> {
  const value = sessionCookieValue(c.req.raw);
  if (value === null) return null;
  const verification = await verifySession(c.env.DB, value);
  const sink = backgroundSink(c);
  for (const work of verification.background) sink(work);
  if (verification.outcome !== "authenticated") return null;
  const directive =
    verification.setCookie === null
      ? undefined
      : sessionSetCookie(verification.setCookie, verification.remember);
  return seeOther("/", directive);
}

/** Install-page re-render: fresh window state + the panel error (200, the
 *  inline-failure posture). */
async function renderInstall(
  c: RouteContext,
  panel: { open: boolean; error: string | null },
): Promise<Response> {
  const assembled = await pageContext(c);
  if ("response" in assembled) return assembled.response;
  return c.html(renderInstallPage({ ctx: assembled.ctx, adminInit: panel }), 200);
}

// ---------------------------------------------------------------------------
// The admin-init window (GET/POST /install)
// ---------------------------------------------------------------------------

/** GET /install — the panel while NO human user row exists (the service
 *  gate's predicate — the migration-seeded system principals `assets` and
 *  `gitea:deploy-key` never close it); 303 to `/` once one exists
 *  (upstream's post-install posture: the install page simply goes away). */
async function installPage(c: RouteContext): Promise<Response> {
  const signedIn = await redirectIfSignedIn(c);
  if (signedIn !== null) return signedIn;
  if (!(await initWindowOpen(c.env.DB))) return seeOther("/");
  return renderInstall(c, { open: true, error: null });
}

/** POST /install — the one-shot creation (module header for the atomicity
 *  argument). Success: session mint + Set-Cookie + 303 `/` (one browser
 *  step: the deployer is signed in as the admin). Race loser: the 200
 *  re-render with the already-initialized verdict, form gone. Validation
 *  failure: the panel re-renders with the inline message. */
async function installSubmit(c: RouteContext): Promise<Response> {
  // §2.8 layer 2 — a non-GET UI write.
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;

  const signedIn = await redirectIfSignedIn(c);
  if (signedIn !== null) return signedIn;

  const fields = await parseAccountForm(c.req.raw);
  // Empty username/email are HTML5-required misses from non-browser
  // clients — the shared ladder renders them like any other invalid input.
  const form: AccountForm = {
    username: fields.admin_name.trim(),
    email: fields.email.trim(),
    password: fields.admin_passwd,
    retype: fields.admin_passwd,
  };
  const result = await initializeAdminUser(c.env.DB, form);

  if (result.outcome === "created") {
    // The auto-login (install.go:479–490 parity): the winner's browser
    // lands on `/` already the admin. Session-scope cookie (no remember on
    // the install form).
    const cookieValue = await mintSession(c.env.DB, result.user.id);
    return seeOther("/", sessionSetCookie(cookieValue, false));
  }
  if (result.outcome === "already-initialized") {
    // The race loser's clear verdict: the message renders, the form does
    // not (the window is closed by the winner's insert).
    return renderInstall(c, { open: false, error: loginFirstRunLocale.init_already_initialized });
  }
  // Invalid — re-read the window honestly (a concurrent winner may have
  // closed it while this form was validating).
  const open = await initWindowOpen(c.env.DB);
  return renderInstall(c, { open, error: result.message });
}

// ---------------------------------------------------------------------------
// Registration (GET/POST /user/sign_up, the ALLOW_SIGNUP gate)
// ---------------------------------------------------------------------------

/** The gate's 404: pages and routes are HIDDEN while closed (the brief's
 *  posture — an unregistered upstream route shape), the full-shell
 *  not-found page. */
async function signupNotFound(c: RouteContext): Promise<Response> {
  // The manifest load must not 503-mask a gated route: the 404 is the
  // answer regardless of asset state; a build failure keeps its 503.
  const assembled = await pageContext(c);
  if ("response" in assembled) return assembled.response;
  return c.html(renderNotFound(assembled.ctx), 404);
}

/** GET /user/sign_up (auth.SignUp) — 404 while ALLOW_SIGNUP is closed. */
async function signUpPage(c: RouteContext): Promise<Response> {
  if (!allowSignup(c.env)) return signupNotFound(c);
  const signedIn = await redirectIfSignedIn(c);
  if (signedIn !== null) return signedIn;
  const assembled = await pageContext(c);
  if ("response" in assembled) return assembled.response;
  return c.html(renderSignUpPage({ ctx: assembled.ctx, error: null }), 200);
}

/** POST /user/sign_up (auth.SignUpPost) — 404 while closed; the shared
 *  account ladder validates; success mints the session (upstream's
 *  handleSignIn, auth.go:632) and 303s to `/`. */
async function signUpSubmit(c: RouteContext): Promise<Response> {
  if (!allowSignup(c.env)) return signupNotFound(c);

  // §2.8 layer 2 — a non-GET UI write.
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;

  const signedIn = await redirectIfSignedIn(c);
  if (signedIn !== null) return signedIn;

  const fields = await parseAccountForm(c.req.raw);
  const form: AccountForm = {
    username: fields.user_name.trim(),
    email: fields.email.trim(),
    password: fields.password,
    retype: fields.retype,
  };
  const result = await registerUser(c.env.DB, form);

  const reRender = async (message: string): Promise<Response> => {
    const assembled = await pageContext(c);
    if ("response" in assembled) return assembled.response;
    return c.html(
      renderSignUpPage({
        ctx: assembled.ctx,
        error: message,
        values: { userName: form.username, email: form.email },
      }),
      200,
    );
  };

  switch (result.outcome) {
    case "created": {
      const cookieValue = await mintSession(c.env.DB, result.user.id);
      return seeOther("/", sessionSetCookie(cookieValue, false));
    }
    case "invalid":
      return reRender(result.message);
    case "name-taken":
      return reRender(signUpLocale.name_taken);
    case "email-taken":
      return reRender(signUpLocale.email_taken);
  }
}

// ---------------------------------------------------------------------------
// The router — mounted by the dispatcher BEFORE the uiRouter (the mount
// record at the module head): app.route("/", firstRunRouter);
// ---------------------------------------------------------------------------

export const firstRunRouter = new Hono<{ Bindings: FirstRunEnv }>();

firstRunRouter.get("/install", (c) => installPage(c));
firstRunRouter.post("/install", (c) => installSubmit(c));
firstRunRouter.get("/user/sign_up", (c) => signUpPage(c));
firstRunRouter.post("/user/sign_up", (c) => signUpSubmit(c));
