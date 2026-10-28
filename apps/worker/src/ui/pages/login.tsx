/**
 * The login page (SPEC-0010 §2.1/§2.2): the sign-in form in the anonymous
 * shell. The credential is a PAT posted as `password` (`token` accepted as a
 * field alias) — token-as-password mirrors the Basic convention SPEC-0002
 * §2.2 already accepts, so one mental model covers both surfaces. Plain HTML
 * form — no client script; the page must work with JS disabled.
 *
 * Shape mirrors gitea/templates/user/auth/signin.tmpl + signin_inner.tmpl at
 * the pin (page-content `user signin`, the attached header/segment pair, the
 * `.ui.form` fields) reduced to the fields SPEC-0010 §2.2 defines: optional
 * `user_name` (owner cross-check), `password`, `remember`, and a hidden
 * `redirect_to` carried through to the POST.
 *
 * ## First-run amendment (SPEC-0010 §6, 2026-10-28)
 *
 * On a ZERO-USER instance the page additionally renders the admin-init form
 * (`adminInit.open`) — upstream's install-page admin-creation posture
 * (routers/install/install.go:452–478 `initAdminUser` over
 * services/forms/user_form.go:54–57's AdminName/AdminEmail/AdminPasswd
 * InstallForm fields and templates/install.tmpl:227–247's "Administrator
 * Account Settings" section), mounted on OUR login page instead of a
 * separate install wizard. The POST targets `/install` (the first-run
 * router, src/ui/first-run.ts) and is atomic — see the service
 * (services/user-accounts.ts). When `signUpLink` is set (the `ALLOW_SIGNUP`
 * var is on) the sign-in segment carries upstream's register link
 * (signin_inner.tmpl:68–71, `ShowRegistrationButton` → `auth.sign_up_now`).
 * Both props are OPTIONAL and default absent: the SPEC-0010 §5 golden
 * (session-goldens/login.html) is byte-stable, and the session router's
 * call site passes the values on GET /login (MOUNTED at df1e362 — the
 * mount record at the bottom).
 */

import { BaseLayout, renderPage } from "../shell";
import { locale } from "../locale";
import type { UiContext } from "../ui-context";

/** Component-local strings for the first-run surfaces (the orgCreateLocale
 *  pattern — locale.ts is shared and not this wave's file). Upstream keys
 *  cited per entry. */
export const loginFirstRunLocale = {
  /** "install.admin_title" */
  init_title: "Administrator Account Settings",
  /** "install.admin_setting_desc", reworded for the one-shot window: the
   *  first registered user does NOT auto-promote here — the window is the
   *  only admin path. */
  init_desc:
    "This instance has no accounts yet. Create the administrator account to finish initializing it.",
  /** "install.admin_name" */
  init_admin_name: "Administrator Username",
  /** "install.admin_email" */
  init_admin_email: "Email Address",
  /** "install.admin_password" — accepted-and-ignored (PAT-only auth,
   *  SPEC-0002 §4.6.7); the note keeps the field honest. */
  init_admin_password: "Password",
  init_password_note:
    "Sign-in uses personal access tokens (PATs) — create one under your account settings after signing in. This field is kept for the upstream install form's shape and is not stored.",
  /** "install.submit" */
  init_submit: "Initialize This Instance",
  /** The one-shot race loser's verdict (cf-gitea addition; upstream's
   *  install.admin_user_recreation_disallowed posture). */
  init_already_initialized: "This instance is already initialized — sign in instead.",
  /** "register" (navbar-less pages use the form-footer link) */
  sign_up_now: "Register now.", // "auth.sign_up_now"
} as const;

/** The admin-init panel state the router passes (absent = no panel at all —
 *  the golden-stable default render). `error` is the POST's server-side
 *  inline failure (200 re-render, the §2.2 posture). */
export interface AdminInitPanel {
  /** `true` renders the form (the users table is empty); `false` with a
   *  set `error` renders only the message — the race loser's page. */
  open: boolean;
  error: string | null;
}

/** The admin-init form section (upstream install.tmpl:227–247 reduced to
 *  the three fields the service validates). Field names follow the upstream
 *  InstallForm's `admin_name`/`admin_email`/`admin_passwd`. */
function AdminInitSection(props: { panel: AdminInitPanel }) {
  return (
    <div class="tw-flex tw-flex-col tw-gap-4">
      <h4 class="ui top attached header center">{loginFirstRunLocale.init_title}</h4>
      <div class="ui attached segment">
        <p class="tw-mb-4">{loginFirstRunLocale.init_desc}</p>
        {props.panel.error !== null ? (
          <div class="ui negative message">{props.panel.error}</div>
        ) : null}
        {props.panel.open ? (
          <form class="ui form" action="/install" method="post">
            <div class="field">
              <label for="admin_name">{loginFirstRunLocale.init_admin_name}</label>
              <input id="admin_name" name="admin_name" type="text" autocomplete="username" required />
            </div>
            <div class="field">
              <label for="admin_email">{loginFirstRunLocale.init_admin_email}</label>
              <input id="admin_email" name="admin_email" type="email" required />
            </div>
            <div class="field">
              <label for="admin_passwd">{loginFirstRunLocale.init_admin_password}</label>
              <input
                id="admin_passwd"
                name="admin_passwd"
                type="password"
                autocomplete="new-password"
              />
              <p class="tw-text-sm tw-text-grey">{loginFirstRunLocale.init_password_note}</p>
            </div>
            <div class="field">
              <button type="submit" class="ui primary button tw-w-full">
                {loginFirstRunLocale.init_submit}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

/** The sign-in form. `error` is the server-side inline failure message
 *  (§2.2: failures re-render at 200, never an HTTP error status). */
export function LoginPage(props: {
  ctx: UiContext;
  redirectTo: string | null;
  error: string | null;
  /** First-run amendment: the admin-init panel + the registration link. */
  adminInit?: AdminInitPanel;
  signUpLink?: boolean;
}) {
  const { ctx } = props;
  return (
    <BaseLayout ctx={ctx} title={locale.sign_in} pageClass="user signin">
      <div class="ui middle very relaxed page grid">
        <div class="column tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
          <h4 class="ui top attached header center">{locale.sign_in}</h4>
          <div class="ui attached segment">
            <form class="ui form" action="/login" method="post">
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              <div class="field">
                <label for="user_name">{locale.uname_holder}</label>
                <input id="user_name" name="user_name" type="text" autocomplete="username" autofocus />
              </div>
              <div class="field">
                <label for="password">{locale.password}</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autocomplete="current-password"
                  required
                />
              </div>
              <div class="inline field">
                <div class="ui checkbox">
                  <label for="remember">{locale.remember_me}</label>
                  <input id="remember" name="remember" type="checkbox" />
                </div>
              </div>
              <input type="hidden" name="redirect_to" value={props.redirectTo ?? ""} />
              <div class="field">
                <button type="submit" class="ui primary button tw-w-full">
                  {locale.sign_in}
                </button>
              </div>
            </form>
            {props.signUpLink === true ? (
              <p class="tw-mt-4">
                <a href="/user/sign_up">{loginFirstRunLocale.sign_up_now}</a>
              </p>
            ) : null}
          </div>
          {props.adminInit !== undefined ? <AdminInitSection panel={props.adminInit} /> : null}
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-page render the session router answers with — the hono/jsx
 *  invocations live in .tsx modules (render.tsx's split, SPEC-0008 §2.4),
 *  so the router module (ui/session.ts) stays JSX-free.
 *
 * MOUNTED at df1e362 (the first-run amendment's orchestrator call site):
 * the session router passes the two options on GET /login — `adminInit`
 * from `initWindowOpen(c.env.DB)` (`{ open: true, error: null }` while the
 * window is open, absent otherwise) and `signUpLink` from
 * `allowSignup(c.env)`; POST /login needs no change. The standalone GET
 * /install route (src/ui/first-run.ts) renders the same page with the
 * panel set. (The first-run router itself mounts BEFORE the uiRouter —
 * Hono's RegExpRouter gives a later-mounted dynamic /:owner/:repo pair
 * precedence over statics; the order fix is 9d77172.) */
export function renderLoginPage(options: {
  ctx: UiContext;
  redirectTo: string | null;
  error: string | null;
  adminInit?: AdminInitPanel;
  signUpLink?: boolean;
}): string {
  return renderPage(
    <LoginPage
      ctx={options.ctx}
      redirectTo={options.redirectTo}
      error={options.error}
      adminInit={options.adminInit}
      signUpLink={options.signUpLink}
    />,
  );
}
