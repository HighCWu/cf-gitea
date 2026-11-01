/**
 * The TOTP two-factor pages (pages wave — the 2FA unit):
 *
 *   - `TwofaPage` — the login gate's passcode form, templates/user/auth/
 *     twofa.tmpl at the pin (`page-content user signin`, the attached
 *     header/segment pair, the `passcode` field with the one-time-code
 *     autocomplete, the verify button + the "Use a scratch code" link to
 *     /user/two_factor/scratch). Rendered ONLY for a request carrying a
 *     valid pending-2FA ticket (upstream's "in a 2FA session" precondition,
 *     routers/web/auth/2fa.go:36-39); the router owns that gate.
 *   - `TwofaScratchPage` — twofa_scratch.tmpl at the pin (the scratch-code
 *     field, `autocomplete="off"`).
 *   - `TwofaEnrollPage` — templates/user/settings/security/twofa_enroll.tmpl
 *     over the settings layout (`pageClass "user settings twofa"`, the
 *     shared UserSettingsNavbar, the enroll header + passcode form).
 *
 * Both gate pages render in the ANONYMOUS shell — the user is mid-login,
 * upstream's session carries no UID yet (base/head without a SignedUser).
 * Plain HTML forms, the no-JS rule. The gate routes live in src/ui/session.ts
 * (the session router — mounted at "/"); the settings four (enroll GET+POST,
 * regenerate_scratch, disable) are the module-header HANDOFF recipe at the
 * bottom (the unlink arm's pattern — userSettingsTabPrologue is
 * index.ts-private).
 *
 * ## The no-QR divergence (the disclosed enrollment-surface reduction)
 *
 * Upstream's enroll page renders `otpKey.Image(320, 240)` — a QR PNG
 * (security/2fa.go:131-143) under "Scan this image with your authentication
 * application:". Porting a barcode/QR encoder + PNG writer is NOT a trivial
 * dependency (upstream pulls boombuler/barcode for it); this port renders
 * the otpauth:// URI ITSELF as a selectable string instead of an image —
 * authenticator apps (and their "enter a setup key" arms) accept the URI
 * verbatim, and the manual-secret line below it is upstream's own fallback
 * (`settings.or_enter_secret`). The scan-line + img bytes are replaced by
 * the URI block; everything else keeps the template's shape.
 *
 * ## The disable-arm passcode field (the mission's mandate, a DIVERGENCE)
 *
 * The enrolled arm's disable form (security/twofa.tmpl) is upstream a bare
 * confirm dialog; THIS port adds a required passcode input — a hijacked
 * session must not be able to strip 2FA with one click. The seam
 * (applyTwofaDisable in src/auth/two-factor.ts) verifies the code without
 * consuming it; recorded as a deliberate divergence in that module's header.
 */

import { BaseLayout, renderPage } from "../shell";
import { UserSettingsNavbar } from "../components/settings-nav";
import type { Child } from "hono/jsx";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// The component-local locale (the orgCreateLocale pattern — locale.ts is
// shared and not this wave's file; upstream keys cited per entry)
// ---------------------------------------------------------------------------

export const twofaLocale = {
  twofa: "Two-Factor Authentication", // "twofa" (the gate page's title + header)
  twofa_scratch: "Two-Factor Scratch Code", // "twofa_scratch"
  passcode: "Passcode", // "passcode"
  verify: "Verify", // "auth.verify"
  use_scratch_code: "Use a scratch code", // "auth.use_scratch_code"
  scratch_code: "Scratch code", // "auth.scratch_code"
  passcode_incorrect:
    "Your passcode is incorrect. If you misplaced your device, use your scratch code to sign in.", // "auth.twofa_passcode_incorrect"
  scratch_token_incorrect: "Your scratch code is incorrect.", // "auth.twofa_scratch_token_incorrect"
  twofa_enroll: "Enroll in Two-Factor Authentication", // "settings.twofa_enroll" (the enroll page's header)
  or_enter_secret: "Or enter the secret: %s", // "settings.or_enter_secret"
  then_enter_passcode: "And enter the passcode shown in the application:", // "settings.then_enter_passcode"
  security: "Security", // "settings.security" (the enroll page's <title> — the settings family's tab-title convention)
  enrolled_success:
    "Your account has been successfully enrolled. Store your single-use recovery key (%s) in a safe place, as it will not be shown again.", // "settings.twofa_enrolled"
  scratch_regenerated:
    "Your single-use recovery key is now %s. Store it in a safe place, as it will not be shown again.", // "settings.twofa_scratch_token_regenerated"
  passcode_invalid: "The passcode is incorrect. Try again.", // "settings.passcode_invalid" (the disable arm's invalid-code notice — the mission's code requirement has no upstream message; the enroll arm's own string covers it)
} as const;

// ---------------------------------------------------------------------------
// The login gate pages (twofa.tmpl + twofa_scratch.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The gate's shared frame — both templates are the sign-in page's grid
 *  (`page-content user signin`, a `column` carrying one form). The
 *  BaseLayout holds the pageClass. */
function GateFrame(props: { ctx: UiContext; title: string; children: Child }) {
  return (
    <BaseLayout ctx={props.ctx} title={props.title} pageClass="user signin">
      <div class="ui middle very relaxed page grid">
        <div class="column">
          {/* twofa.tmpl's `ui form tw-max-w-2xl tw-m-auto` form; the action
              is the template's {{.Link}} — the page's own path. */}
          {props.children}
        </div>
      </div>
    </BaseLayout>
  );
}

/** The passcode gate (twofa.tmpl at the pin, byte-shape). */
export function TwofaPage(props: { ctx: UiContext; error: string | null }) {
  return (
    <GateFrame ctx={props.ctx} title={twofaLocale.twofa}>
      <form class="ui form tw-max-w-2xl tw-m-auto" action="/user/two_factor" method="post">
        <h3 class="ui top attached header">{twofaLocale.twofa}</h3>
        <div class="ui attached segment">
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          <div class="required field">
            <label for="passcode">{twofaLocale.passcode}</label>
            <input id="passcode" name="passcode" type="text" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" autofocus required />
          </div>
          <div class="inline field">
            <button type="submit" class="ui primary button">
              {twofaLocale.verify}
            </button>
            <a href="/user/two_factor/scratch">{twofaLocale.use_scratch_code}</a>
          </div>
        </div>
      </form>
    </GateFrame>
  );
}

/** The scratch-code gate (twofa_scratch.tmpl at the pin, byte-shape). */
export function TwofaScratchPage(props: { ctx: UiContext; error: string | null }) {
  return (
    <GateFrame ctx={props.ctx} title={twofaLocale.twofa_scratch}>
      <form class="ui form tw-max-w-2xl tw-m-auto" action="/user/two_factor/scratch" method="post">
        <h3 class="ui top attached header">{twofaLocale.twofa_scratch}</h3>
        <div class="ui attached segment">
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          <div class="required field">
            <label for="token">{twofaLocale.scratch_code}</label>
            <input id="token" name="token" type="text" autocomplete="off" autofocus required />
          </div>
          <div class="inline field">
            <button type="submit" class="ui primary button">
              {twofaLocale.verify}
            </button>
          </div>
        </div>
      </form>
    </GateFrame>
  );
}

/** The full-document renders the session router answers with (the
 *  hono/jsx invocations live in .tsx modules — render.tsx's split, the
 *  renderLoginPage precedent). */
export function renderTwofaGatePage(options: { ctx: UiContext; error: string | null }): string {
  return renderPage(<TwofaPage ctx={options.ctx} error={options.error} />);
}

export function renderTwofaScratchPage(options: { ctx: UiContext; error: string | null }): string {
  return renderPage(<TwofaScratchPage ctx={options.ctx} error={options.error} />);
}

// ---------------------------------------------------------------------------
// The enroll page (twofa_enroll.tmpl over the settings layout)
// ---------------------------------------------------------------------------

/** The enroll page's render inputs: the pending secret + its otpauth URI —
 *  upstream's `.TwofaSecret` and `.QrUri` (the QR replaced by the URI, the
 *  module header). */
export interface TwofaEnrollPageData {
  /** The base32 secret — shown for manual entry (the template's `alt`
   *  attribute carried the same string upstream; here it is the visible
   *  manual-secret line). */
  secret: string;
  /** The otpauth:// URI (upstream's QR payload — `otpKey.String()`). */
  uri: string;
}

/** The enroll page (twofa_enroll.tmpl at the pin): the settings layout's
 *  `user settings twofa` pageClass, the shared navbar over the Security
 *  tab, the header, the secret block and the passcode form. */
export function TwofaEnrollPage(props: { ctx: UiContext; data: TwofaEnrollPageData }) {
  const { data } = props;
  return (
    <BaseLayout ctx={props.ctx} title={twofaLocale.security} pageClass="user settings twofa">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="security" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            <h4 class="ui top attached header">{twofaLocale.twofa_enroll}</h4>
            <div class="ui attached segment">
              {/* The no-QR divergence (the module header): the scan-line +
                  img pair is replaced by the otpauth URI itself, selectable
                  and paste-able into any authenticator's setup-key arm. */}
              <p>
                <code class="tw-break-all">{data.uri}</code>
              </p>
              <p>{twofaLocale.or_enter_secret.replace("%s", data.secret)}</p>
              <p>{twofaLocale.then_enter_passcode}</p>
              <form class="ui form" action="/user/settings/security/two_factor/enroll" method="post">
                <div class="inline required field">
                  <label for="passcode">{twofaLocale.passcode}</label>
                  {/* The template's bare `<input id="passcode" name="passcode"
                      autofocus required>` — no type attribute upstream
                      (defaults text), none here. */}
                  <input id="passcode" name="passcode" autofocus required />
                </div>
                <div class="inline field">
                  <label></label>
                  <button type="submit" class="ui primary button">
                    {twofaLocale.verify}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document render (the recipe handlers call this). */
export function renderTwofaEnrollPage(ctx: UiContext, data: TwofaEnrollPageData): string {
  return renderPage(<TwofaEnrollPage ctx={ctx} data={data} />);
}

// ---------------------------------------------------------------------------
// The settings-four mount HANDOFF (the module-header recipe — the unlink
// arm's pattern; NEVER folded from here, the orchestrator's index.ts window
// owns the registrations)
//
//   import {
//     applyTwofaDisable, applyTwofaEnrollment, generateTotpSecret,
//     getTwoFactorByUid, hasTwoFactorByUid, mintPendingTicket, otpauthUri,
//     regenerateScratchToken, twofaCookieValue, twofaIssuer, twofaSetCookie,
//     verifyPendingTicket,
//   } from "../../auth/two-factor";
//   import { readUrlEncodedForm } from "../forms";
//   import {
//     loadUserSettingsSecurityPageData, renderUserSettingsSecurityPage,
//     userSettingsSecurityLocale,
//   } from "./pages/user-settings-security";
//   import { renderTwofaEnrollPage, twofaLocale } from "./pages/twofa";
//
//   const ENROLL_PATH = "/user/settings/security/two_factor";
//
//   // GET {ENROLL_PATH}/enroll (security/2fa.go:164-192): prologue → the
//   // already-enrolled refusal → begin/reuse the pending secret → render.
//   async function twofaEnrollPage(c: Context<{ Bindings: Env }>): Promise<Response> {
//     const p = await userSettingsTabPrologue(c, false);
//     if (!p.ok) return p.response;
//     if (await hasTwoFactorByUid(c.env.DB, p.viewer.id)) {
//       return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/security" } }));
//     }
//     const incoming = twofaCookieValue(c.req.raw);
//     const ticket = incoming === null ? null : await verifyPendingTicket(c.env.DB, incoming, "enroll");
//     const secret = ticket?.kind === "enroll" ? ticket.secret : generateTotpSecret();
//     const issuer = twofaIssuer(c.env.APP_URL);
//     const data = { secret, uri: otpauthUri(secret, issuer, p.viewer.username) };
//     const setCookie = ticket?.kind === "enroll" ? undefined : twofaSetCookie(await mintPendingTicket(c.env.DB, { kind: "enroll", secret }));
//     const html = renderTwofaEnrollPage(p.ctx, data);
//     if (setCookie === undefined) return p.respond(c.html(html, 200));
//     return p.respond(c.html(html, 200, { "set-cookie": setCookie }));
//   }
//
//   // POST {ENROLL_PATH}/enroll (security/2fa.go:195-286): verify-once
//   // activates; the scratch token renders ONCE in the security page's
//   // positive notice (the once-only carrier — the flash rides no wire).
//   async function twofaEnrollSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
//     const p = await userSettingsTabPrologue(c, true);
//     if (!p.ok) return p.response;
//     const params = await readUrlEncodedForm(c.req.raw);
//     const outcome = await applyTwofaEnrollment(
//       c.env.DB, p.viewer.id, params.get("passcode") ?? "", twofaCookieValue(c.req.raw),
//     );
//     if (outcome.outcome === "enrolled") {
//       const data = await loadUserSettingsSecurityPageData(c.env.DB, p.viewer.id);
//       return p.respond(c.html(renderUserSettingsSecurityPage(p.ctx, data, {
//         notice: { kind: "positive",
//           message: twofaLocale.enrolled_success.replace("%s", outcome.scratchToken) },
//       })), 200);
//     }
//     if (outcome.outcome === "already-enrolled") {
//       return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/security" } }));
//     }
//     if (outcome.outcome === "no-pending-secret") {
//       return p.respond(new Response(null, { status: 303, headers: { location: ENROLL_PATH + "/enroll" } }));
//     }
//     // invalid-passcode: upstream re-renders the enroll page with the flash;
//     // the plain-form reduction 303s back to the GET, whose pending stash
//     // survives so the SAME secret re-renders (the seam's disclosed arm).
//     return p.respond(new Response(null, { status: 303, headers: { location: ENROLL_PATH + "/enroll" } }));
//   }
//
//   // POST {ENROLL_PATH}/regenerate_scratch (security/2fa.go:31-66): the new
//   // token renders ONCE (the notice carrier, the enroll arm's posture).
//   async function twofaRegenerateScratch(c: Context<{ Bindings: Env }>): Promise<Response> {
//     const p = await userSettingsTabPrologue(c, true);
//     if (!p.ok) return p.response;
//     const row = await getTwoFactorByUid(c.env.DB, p.viewer.id);
//     if (row === null) {
//       return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/security" } }));
//     }
//     const token = await regenerateScratchToken(c.env.DB, row);
//     const data = await loadUserSettingsSecurityPageData(c.env.DB, p.viewer.id);
//     return p.respond(c.html(renderUserSettingsSecurityPage(p.ctx, data, {
//       notice: { kind: "positive",
//         message: twofaLocale.scratch_regenerated.replace("%s", token) },
//     })), 200);
//   }
//
//   // POST {ENROLL_PATH}/disable (security/2fa.go:69-104 + the mission's
//   // code requirement): the passcode field is REQUIRED — an empty/invalid
//   // code re-renders the security page with the negative notice.
//   async function twofaDisable(c: Context<{ Bindings: Env }>): Promise<Response> {
//     const p = await userSettingsTabPrologue(c, true);
//     if (!p.ok) return p.response;
//     const params = await readUrlEncodedForm(c.req.raw);
//     const outcome = await applyTwofaDisable(c.env.DB, p.viewer.id, params.get("passcode") ?? "");
//     if (outcome.outcome === "disabled") {
//       return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/security" } }));
//     }
//     const data = await loadUserSettingsSecurityPageData(c.env.DB, p.viewer.id);
//     return p.respond(c.html(renderUserSettingsSecurityPage(p.ctx, data, {
//       notice: { kind: "negative",
//         message: outcome.outcome === "invalid-code" ? twofaLocale.passcode_invalid : userSettingsSecurityLocale.twofa_not_enrolled },
//     })), 200);
//   }
//
//   uiRouter.get(ENROLL_PATH + "/enroll", (c) => twofaEnrollPage(c));
//   uiRouter.post(ENROLL_PATH + "/enroll", (c) => twofaEnrollSubmit(c));
//   uiRouter.post(ENROLL_PATH + "/regenerate_scratch", (c) => twofaRegenerateScratch(c));
//   uiRouter.post(ENROLL_PATH + "/disable", (c) => twofaDisable(c));
//   // the GET twins of the three POSTs answer methodNotAllowed("POST") (chi's
//   // 405 — the job_queue posture)
// ---------------------------------------------------------------------------
