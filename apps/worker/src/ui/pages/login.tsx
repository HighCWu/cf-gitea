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
 */

import { BaseLayout, renderPage } from "../shell";
import { locale } from "../locale";
import type { UiContext } from "../ui-context";

/** The sign-in form. `error` is the server-side inline failure message
 *  (§2.2: failures re-render at 200, never an HTTP error status). */
export function LoginPage(props: { ctx: UiContext; redirectTo: string | null; error: string | null }) {  const { ctx } = props;
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
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-page render the session router answers with — the hono/jsx
 *  invocations live in .tsx modules (render.tsx's split, SPEC-0008 §2.4),
 *  so the router module (ui/session.ts) stays JSX-free. */
export function renderLoginPage(options: {
  ctx: UiContext;
  redirectTo: string | null;
  error: string | null;
}): string {
  return renderPage(
    <LoginPage ctx={options.ctx} redirectTo={options.redirectTo} error={options.error} />,
  );
}
