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
 * ## The credential-label divergence (the B-1 usability fix, 2026-10-30)
 *
 * The credential field's VISIBLE label reads "Access Token", not
 * "Password": upstream labels it with locale key `password` because
 * upstream HAS a password store, while our credential is a PAT
 * (SPEC-0002 §4.6.7 divergence 7 — no password store; SPEC-0010 §2.2
 * token-as-password) and a "Password" label on a PAT field is the decoy
 * the first-run audit flagged (docs/usability/findings-first-run.md
 * blocker 1 — a just-registered "password" can never sign in). A short
 * helper under the field names the token's source (Settings →
 * Applications). DOCUMENTED DIVERGENCE required by the platform posture —
 * upstream's own strings cannot be copied here truthfully. Only the label
 * text diverges: the input keeps `name="password"`/`id="password"`,
 * `type="password"` (secret masking) and `autocomplete="current-password"`
 * (so password managers can retain the PAT — the wire shape is SPEC-0010
 * §2.2 verbatim).
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
 *
 * ## The external-auth buttons (specs/external-auth-sources.md §5.6, W4)
 *
 * `renderLoginPage` gains the OPTIONAL `oauth2Sources` member (the SPEC's
 * option pattern again — absent = byte-stable golden): the ACTIVE OAuth2
 * login sources, one store read (listActiveOAuth2Sources — `is_active AND
 * type = 6`, name order), rendered as the pin's social block:
 * signin_inner.tmpl:50-56's `sign_in_or` divider + external_auth_methods.tmpl's
 * `#external-login-navigator` anchors (one per source, href
 * `/user/oauth2/{Source.Name}`, the icon-or-fallback glyph + "Sign in with
 * {name}"). The signup page renders the same block inside its form
 * (signup_inner.tmpl:50-56's position) through the shared ExternalAuthMethods
 * export. DISCLOSED TRANSIENT: the hrefs target the `/user/oauth2/{source}`
 * route family whose handlers are W2's (services/web/oauth2-login) — until
 * that mount lands in the dispatcher's registration window a click is the
 * honest 404 (the module renders the buttons on DATA alone; a
 * constant-gated flip would be an invention upstream has no analog of —
 * upstream's buttons render whenever an active source exists, full stop).
 * The buttons enumerate ACTIVE rows with a parsable cfg only — a dead
 * (unparsable) cfg cannot complete a login chain, so it renders no button
 * (the cfg codec's dead-source rule). No client script — anchors, the
 * no-JS form rule intact.
 */

import { BaseLayout, Icon, renderPage } from "../shell";
import { locale } from "../locale";
import { parseOAuth2SourceConfig } from "../../services/auth-sources/cfg";
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
  /** The sign-in credential helper (cf-gitea addition — the B-1 fix): the
   *  field label itself diverges in locale.ts ("Access Token"); this helper
   *  occupies the slot upstream fills with the "Forgot password?" link
   *  (signin_inner.tmpl's tw-flex label row) — meaningless without a
   *  password store (SPEC-0002 §4.6.7). */
  credential_note:
    "Sign in with a personal access token (PAT), not a password — accounts on this instance have no passwords. Create a token under Settings → Applications.",
  /** "register" (navbar-less pages use the form-footer link) */
  sign_up_now: "Register now.", // "auth.sign_up_now"
} as const;

/** The external-auth block's strings (component-local — locale.ts is
 *  shared and not this wave's file; upstream keys cited). */
export const loginOAuth2Locale = {
  sign_in_or: "or", // "sign_in_or" (signin_inner.tmpl:52 / signup_inner.tmpl:53)
  sign_in_with_provider: "Sign in with %s", // "sign_in_with_provider" (external_auth_methods.tmpl:4)
} as const;

/** One login button's render inputs — the ACTIVE OAuth2 source row
 *  projected (the session router's read → this shape; the mapper is
 *  oauth2LoginSourceButtons below). `name` is Source.Name — upstream
 *  AuthSourceProvider.DisplayName (providers.go:53-55): the URL token AND
 *  the button text AND the W2 flow's name-keyed lookup
 *  (models/auth/oauth2.go:664-677) all ride it. */
export interface OAuth2LoginSourceButton {
  name: string;
  /** The goth registry key (the cfg provider) — the fallback glyph's pick. */
  provider: string;
  /** The cfg IconURL override (providers.go:63-70's img arm); null = the
   *  brand-glyph fallback. */
  iconUrl: string | null;
}

/** The fallback brand glyphs for the icon-less buttons — the submodule's
 *  exact svg bytes (the pull-merge-box FOLD_SVG / ADMIN_EMBEDDED_ICONS
 *  precedent; gitea/public/assets/img/svg/ at the pin, goth's Fomantic
 *  `<i>` icons need an icon font this static shell does not carry). The
 *  unknown/foreign provider falls to the allowlisted octicon-globe. */
const OAUTH2_PROVIDER_GLYPHS: Record<string, { viewBox: string; paths: Array<{ d: string; fill?: string }> }> = {
  // octicon-mark-github.svg (viewBox 0 0 16 16, one unfilled path — the
  // currentColor default upstream octicons render with).
  github: {
    viewBox: "0 0 16 16",
    paths: [
      {
        d: "M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656",
      },
    ],
  },
  // gitea-google.svg (viewBox 0 0 24 24, four brand fills + the none frame).
  gplus: {
    viewBox: "0 0 24 24",
    paths: [
      { fill: "#4285f4", d: "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09" },
      { fill: "#34a853", d: "M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23" },
      { fill: "#fbbc05", d: "M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22z" },
      { fill: "#ea4335", d: "M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53" },
      { fill: "none", d: "M1 1h22v22H1z" },
    ],
  },
  // gitea-openid.svg (viewBox 0 0 2400 2400, three fills).
  openidConnect: {
    viewBox: "0 0 2400 2400",
    paths: [
      { fill: "#ff7c00", d: "m1270 218.3-173.1 84.3-.7 981.8c-.3 540 .2 981.4 1.1 981l174.5-81.8 172.3-80.8v-984.4c0-541.7-.2-984.7-.4-984.4z" },
      { fill: "#aaa", d: "M981.9 785.5c-425.3 63.2-766.5 264.1-889 523a491.5 491.5 0 0 0-43.6 146c-4.2 29.2-4.7 95-1.2 124 19 152.6 115.2 299.9 273.2 418.8 147.7 111 350.5 196.5 568.6 239.7 59 11.6 179 29 200.5 29 2.3 0 3-23.2 3-109.1v-109.2l-5.1-1-37.9-6a1182 1182 0 0 1-305.4-90.6c-122.2-55.7-225.1-137.7-284.6-226.4-107.5-160.5-81.3-344.3 70-491.3 57-55.5 115.4-95.2 199.5-136.1a1112.6 1112.6 0 0 1 269.4-89.2l29.7-6c3.7-1.2 4-8.6 4-111.5V779.5l-6.3.2a823 823 0 0 0-44.8 5.8m525 104c0 103 .2 110.4 4.1 111.6l29.5 6a1221.6 1221.6 0 0 1 207.7 61.3A1088 1088 0 0 1 1862 1123c4.6 3.7 1.4 5.8-88 56-51.1 28.5-93 52.7-93 53.4 0 1.9 671.6 146.8 673.2 145.2 1.2-1.2-45.5-496-47-497.6-.2-.2-38.5 21-85 47.2l-89.6 50.2c-4.2 2-8.8.2-27.9-10.7-130.8-75-289.6-132.2-460.8-166.1a1871 1871 0 0 0-132.9-21.1c-4 0-4.2 6.7-4.2 110z" },
      { fill: "#cbaa7c", d: "M1094.5 2156.9c0 60.6.3 85.5.5 55 .5-30.2.5-79.9 0-110.3-.2-30.2-.5-5.3-.5 55.3" },
    ],
  },
};

/** The `$provider.IconHTML 24` render (providers.go:63-72): the cfg
 *  IconURL's img markup verbatim, else the brand glyph (24px, external_auth_methods.tmpl:3's
 *  size), else the octicon-globe fallback. */
function ProviderIcon(props: { source: OAuth2LoginSourceButton }) {
  if (props.source.iconUrl !== null) {
    // providers.go:63-70's img arm verbatim (alt = DisplayName).
    return (
      <img class="tw-object-contain" width="24" height="24" src={props.source.iconUrl} alt={props.source.name} />
    );
  }
  const glyph = OAUTH2_PROVIDER_GLYPHS[props.source.provider];
  if (glyph === undefined) {
    // The SPEC §5.6 "icon-or-fallback" arm — the allowlisted globe.
    return <Icon name="octicon-globe" size={24} />;
  }
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={glyph.viewBox} width="24" height="24" aria-hidden="true">
      {glyph.paths.map((p) => (
        <path d={p.d} fill={p.fill} />
      ))}
    </svg>
  );
}

/** The ACTIVE source rows → the button shapes (the session/first-run
 *  routers' mapper): a dead (unparsable) cfg row renders NO button — it
 *  cannot complete a login chain (the codec's dead-source rule; upstream's
 *  xorm cfg always parses, so this arm has no upstream analog). Name order
 *  is the read's (listActiveOAuth2Sources). */
export function oauth2LoginSourceButtons(rows: Array<{ name: string; cfg: string }>): OAuth2LoginSourceButton[] {
  const buttons: OAuth2LoginSourceButton[] = [];
  for (const row of rows) {
    try {
      const cfg = parseOAuth2SourceConfig(row.cfg);
      buttons.push({ name: row.name, provider: cfg.provider, iconUrl: cfg.iconUrl ?? null });
    } catch {
      // dead cfg — skip
    }
  }
  return buttons;
}

/** The social block (signin_inner.tmpl:50-56 + external_auth_methods.tmpl
 *  at the pin): the `sign_in_or` divider + the `#external-login-navigator`
 *  anchors. `withDivider=false` renders the navigator alone (the signup
 *  form's position uses the same pair — callers pass the upstream shape
 *  they mirror). The href: `/user/oauth2/{Source.Name}` — encodeURIComponent
 *  is PathEscape's analog and agrees with it on the slug-validated charset
 *  (SPEC §6.3); `data-require-appurl-check` + `rel="nofollow"` are the
 *  template's own attributes (the former is upstream's JS hardening hook —
 *  inert in the no-JS shell). */
export function ExternalAuthMethods(props: { sources: OAuth2LoginSourceButton[]; withDivider?: boolean }) {
  if (props.sources.length === 0) return null;
  return (
    <>
      {props.withDivider !== false ? <div class="divider divider-text">{loginOAuth2Locale.sign_in_or}</div> : null}
      <div id="external-login-navigator" class="tw-py-1 tw-flex tw-flex-col tw-gap-3">
        {props.sources.map((source) => (
          <a
            class="ui button external-login-link tw-gap-3"
            data-require-appurl-check="true"
            rel="nofollow"
            href={`/user/oauth2/${encodeURIComponent(source.name)}`}
          >
            <ProviderIcon source={source} /> {loginOAuth2Locale.sign_in_with_provider.replace("%s", source.name)}
          </a>
        ))}
      </div>
    </>
  );
}

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
  /** The external-auth buttons (§5.6): absent/empty = no block at all —
   *  the golden-stable default render. */
  oauth2Sources?: OAuth2LoginSourceButton[];
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
                <p class="tw-text-sm tw-text-grey">{loginFirstRunLocale.credential_note}</p>
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
            {/* signin_inner.tmpl:50-56 — the divider + the external-login
                navigator sit AFTER the form inside the same segment, only
                when external methods exist (the non-empty list). */}
            {props.oauth2Sources !== undefined ? <ExternalAuthMethods sources={props.oauth2Sources} /> : null}
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
 * precedence over statics; the order fix is 9d77172.) The EXTERNAL AUTH W4
 * arm adds the `oauth2Sources` read to the same call site (§5.6's one
 * store query — listActiveOAuth2Sources → oauth2LoginSourceButtons;
 * absent while no active source exists, so the golden stays byte-stable).
 */
export function renderLoginPage(options: {
  ctx: UiContext;
  redirectTo: string | null;
  error: string | null;
  adminInit?: AdminInitPanel;
  signUpLink?: boolean;
  oauth2Sources?: OAuth2LoginSourceButton[];
}): string {
  return renderPage(
    <LoginPage
      ctx={options.ctx}
      redirectTo={options.redirectTo}
      error={options.error}
      adminInit={options.adminInit}
      signUpLink={options.signUpLink}
      oauth2Sources={options.oauth2Sources}
    />,
  );
}
