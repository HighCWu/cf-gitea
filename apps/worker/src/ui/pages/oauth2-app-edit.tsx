/**
 * The OAuth2 application EDIT page — the SHARED
 * `user/settings/applications_oauth2_edit_form.tmpl` port plus the
 * owner-parameterized write arms of upstream's `OAuth2CommonHandlers`
 * (routers/web/user/setting/oauth2_common.go). Upstream embeds the ONE form
 * template from all three twins — `user/settings/applications_oauth2_edit.tmpl`
 * (:3-5), `org/settings/applications_oauth2_edit.tmpl` (:3), and
 * `admin/applications/oauth2_edit.tmpl` (:4) — and drives it through the ONE
 * handler struct whose `Owner` is the user, the org's user row, or nil for
 * the instance-wide admin family (oauth2_common.go:21-33). This module is
 * that shape: one form render in three page chromes, one set of write arms
 * keyed on `ownerId` (the uid column — an org's user row shares the id
 * space, the landed org page's owner note; uid 0 is the admin sentinel).
 *
 * ## The write arms (oauth2_common.go, per function)
 *
 *   show       EditShow (:91-106): load by id; `app.UID != ownerID()` ⇒
 *              NotFound. Renders the form with the secret BLANK (the masked
 *              placeholder field).
 *   save       EditSave (:109-147): bind (Required name / Required
 *              redirect_uris / the DetectInvalid Validate hook,
 *              user_form.go:248-273); a bind error re-renders the page; the
 *              success arm calls `auth.UpdateOAuth2Application`
 *              (models/auth/oauth2.go:321-352) and redirects to the list.
 *              THE WEB SAVE DOES NOT ROTATE THE CLIENT SECRET — the model
 *              update overwrites name/redirect_uris/flags ONLY and clears
 *              the in-memory secret (:345-350); the rotation-on-every-PATCH
 *              is the API contract (routers/api/v1/user/app.go
 *              UpdateOauth2Application explicitly calls GenerateClientSecret
 *              — the landed updateOAuth2Application service folds it in per
 *              that contract, its module header). The web arm therefore
 *              carries its own page-local UPDATE here (the landed service is
 *              import-only for this wave) — the two contracts diverge
 *              upstream too, and folding the web arm into the rotating
 *              service would kill every deployed integration's stored
 *              secret on a plain rename.
 *              The model's builtin lock (:330-334) refuses the five
 *              pre-registered client IDs (`application is locked`).
 *   regenerate RegenerateSecret (:150-174): load + UID check, then
 *              `GenerateClientSecret` (oauth2.go:213-224 — generate,
 *              persist the hash, return the plaintext ONCE) and render the
 *              form with the plaintext in the secret field. NOTE the lock
 *              does NOT apply here (upstream's RegenerateSecret has no
 *              builtin arm — a builtin's empty seeded secret may be given a
 *              real value). The persistence updates ONLY the client_secret
 *              column (`Cols("client_secret")`, oauth2.go:221 — no
 *              updated_unix touch).
 *   delete     DeleteApp (:177-193): load by id (no UID check — the model's
 *              delete is (id, uid) scoped, oauth2.go:386-401), builtin lock
 *              (:391-396), then delete. The landed family answers the miss
 *              with the 404 shell (the org/admin pages' documented
 *              divergence — upstream ServerErrors it); the lock refusal
 *              takes the same shell (upstream 500s; existence and lock stay
 *              indistinguishable — strictly the safer posture, disclosed).
 *   create     AddApp (:56-88): bind + validate, CreateOAuth2Application +
 *              GenerateClientSecret, then render THE EDIT PAGE with the
 *              plaintext secret (:79-87 "render the edit page with
 *              secret"). The landed org/admin list re-renders that stood in
 *              for this render retire with the edit page landing (their
 *              module headers' "with no landed edit page" clause).
 *
 * ## The secret-shown-once posture (SPEC specs/oauth2-provider.md §2.8)
 *
 * applications_oauth2_edit_form.tmpl:12-22: `{{if .ClientSecret}}` renders
 * the plaintext in a `type="text" readonly` input; the else arm renders a
 * `type="password" readonly` input carrying the literal `averysecuresecret`
 * placeholder. The plaintext exists ONLY in the create/regenerate response
 * body — the store keeps the PBKDF2 hash (the landed service), and every
 * later show re-renders the masked placeholder. The page also renders the
 * regenerate form (`POST {FormActionPath}/regenerate_secret`, :25-28) whose
 * answer re-renders the page with a fresh plaintext.
 *
 * ## Bind error texts (the locale-composite convention — the org page's)
 *
 * form.require_error "Name cannot be empty." (the landed org page's arm) /
 * "RedirectURIs cannot be empty."; form.max_size_error "Name must contain
 * at most 255 characters."; the DetectInvalid Validate hook composes
 * `RedirectURIs: "<uri>" is not a valid URL.` verbatim
 * (user_form.go:267-269 over form.url_error). Binder order is field order
 * then the Validate hook: name required → name maxsize → redirect required
 * → redirect URL check.
 *
 * ## The builtin lock (BuiltinApplications, models/auth/oauth2.go:64-101)
 *
 * The five pre-registered client IDs (the seed rows are migration 0052's
 * five INSERT OR IGNOREs, uid=0, confidential_client=0): the list template
 * renders the Locked label instead of the edit/delete controls for them
 * (applications_oauth2_list.tmpl:18-21 — the admin list is the only twin
 * whose rows can BE builtins: the user/org lists key on a non-zero uid and
 * the builtins are uid=0), and edit/delete refuse them while regenerate
 * stays allowed (the arms' parity notes above).
 *
 * ## Mount handoff (ui/index.ts — orchestrator-owned)
 *
 * The route handlers calling into this module live in the W5 handoff block
 * (user: /user/settings/applications/oauth2[/…]; org:
 * /{org}/settings/applications/oauth2[/…]; admin:
 * /-/admin/applications/oauth2[/…]) — all gated on
 * `oauth2FeatureEnabled(c.env)` with 403 (`oauth2SettingsForbidden` below,
 * web.go:373-378's oauth2Enabled analog — upstream wraps the user /oauth2
 * subgroup web.go:682-689, the whole org applications group web.go:1030,
 * and the whole admin applications group web.go:896 in it).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  createOAuth2Application,
  deleteOAuth2Application,
  detectInvalidOAuth2ApplicationRedirectURI,
  generateClientSecret,
  getOAuth2ApplicationById,
  type OAuth2AppRow,
} from "../../api/services/oauth2-apps";
import { oauth2Applications } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { OrgSettingsNavbar, UserSettingsNavbar } from "../components/settings-nav";
import { AdminFamilyShell } from "./admin-users";
import { OrgHeader } from "./org-home";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// The builtin lock (BuiltinApplications, models/auth/oauth2.go:64-101).
// ---------------------------------------------------------------------------

/** The five pre-registered client IDs (oauth2.go:71-100, in table order). */
export const BUILTIN_OAUTH2_CLIENT_IDS: readonly string[] = [
  "a4792ccc-144e-407e-86c9-5e7d8d9c3269", // git-credential-oauth
  "e90ee53c-94e2-48ac-9358-a874fb9e0662", // Git Credential Manager
  "d57cb8c4-630c-4168-8324-ec79935e18d4", // tea
  "b757811a-05c8-4c76-8d74-a5ee3d2073f2", // Gitea App
  "75a9ec3e-42b5-40cb-9144-9ea96ecd56a6", // gitea-vscode
];

/** The `BuiltinApplications()` map membership (:66-101) — the list-template
 *  lock arm (applications_oauth2_list.tmpl:18-21) and the write refusals
 *  (:330-334, :391-396). */
export function isBuiltinOauth2Application(clientId: string): boolean {
  return BUILTIN_OAUTH2_CLIENT_IDS.includes(clientId);
}

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern; upstream en-US values at
// the pin, keys cited — the SHARED templates' keys)
// ---------------------------------------------------------------------------

export const oauth2AppEditLocale = {
  /** "settings.edit_oauth2_application" — the h4 (edit_form.tmpl:2) and the
   *  edit pages' document title. */
  edit_oauth2_application: "Edit OAuth2 Application",
  /** "settings.oauth2_application_create_description" — the attached
   *  segment's lead (:5). */
  create_description:
    "OAuth2 applications give your third-party application access to user accounts on this instance.",
  /** "settings.oauth2_client_id" (:9). */
  client_id: "Client ID",
  /** "settings.oauth2_client_secret" (:14, :19). */
  client_secret: "Client Secret",
  /** edit_form.tmpl:20 — the masked field's literal placeholder (verbatim). */
  masked_secret_placeholder: "averysecuresecret",
  /** "settings.oauth2_regenerate_secret_hint" (:26). */
  regenerate_secret_hint: "Lost your secret?",
  /** "settings.oauth2_regenerate_secret" (:27). */
  regenerate_secret: "Regenerate Secret",
  /** "settings.oauth2_application_name" (:34). */
  application_name: "Application Name",
  /** "settings.oauth2_redirect_uris" (:38). */
  redirect_uris: "Redirect URIs. Please use a new line for every URI.",
  /** "settings.oauth2_confidential_client" (:43). */
  confidential_client:
    "Confidential Client. Select for apps that keep the secret confidential, such as web apps. Do not select for native apps, including desktop and mobile apps.",
  /** "settings.oauth2_skip_secondary_authorization" (:49) — the <strong>
   *  tail stripped (the locale-HTML-stripped convention). */
  skip_secondary_authorization: "Skip authorization for public clients after granting access once. May pose a security risk.",
  /** "settings.save_application" (:54). */
  save_application: "Save",
  /** "settings.oauth2_application_locked" — the Locked label's tooltip
   *  (applications_oauth2_list.tmpl:21). */
  application_locked:
    "Gitea pre-registers some OAuth2 applications on startup if enabled in config. To prevent unexpected behavior, these can neither be edited nor removed. Please refer to the OAuth2 documentation for more information.",
  /** "locked" — the Locked label's text (applications_oauth2_list.tmpl:21). */
  locked: "Locked",
} as const;

// ---------------------------------------------------------------------------
// The form (EditOAuth2ApplicationForm, user_form.go:248-254 — the template's
// verbatim field names)
// ---------------------------------------------------------------------------

export interface OAuth2AppEditForm {
  name: string;
  redirectUrisRaw: string;
  confidentialClient: boolean;
  skipSecondaryAuthorization: boolean;
}

/** The urlencoded POST parse (the checkbox tri-state: present+non-empty =
 *  checked, the HTML form contract / upstream's web.FormBool). */
export function parseOauth2AppEditForm(params: URLSearchParams): OAuth2AppEditForm {
  return {
    name: (params.get("application_name") ?? "").trim(),
    redirectUrisRaw: params.get("redirect_uris") ?? "",
    confidentialClient: (params.get("confidential_client") ?? "") !== "",
    skipSecondaryAuthorization: (params.get("skip_secondary_authorization") ?? "") !== "",
  };
}

/** `util.SplitTrimSpace(form.RedirectURIs, "\n")` (oauth2_common.go:68,133 —
 *  the same split the landed org/admin pages carry). */
export function splitRedirectUris(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The binder, in field order then the Validate hook (user_form.go:248-273):
 * `Name` Required → MaxSize(255) → `RedirectURIs` Required → the
 * DetectInvalid URL check. Returns the composite message or null.
 */
export function validateOauth2ApplicationForm(form: OAuth2AppEditForm): string | null {
  if (form.name === "") {
    return "Name cannot be empty."; // form.require_error over "Name"
  }
  if (form.name.length > 255) {
    return "Name must contain at most 255 characters."; // form.max_size_error over Name/255
  }
  if (form.redirectUrisRaw === "") {
    return "RedirectURIs cannot be empty."; // form.require_error over "RedirectURIs"
  }
  const invalid = detectInvalidOAuth2ApplicationRedirectURI(splitRedirectUris(form.redirectUrisRaw));
  if (invalid !== "") {
    // user_form.go:267-269: `RedirectURIs: ` + form.url_error over the
    // QUOTED URI (`"`+invalidURI+`"`).
    return `RedirectURIs: "${invalid}" is not a valid URL.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The write arms (the OAuth2CommonHandlers port, owner-parameterized)
// ---------------------------------------------------------------------------

export type ShowOauth2AppResult = { kind: "ok"; app: OAuth2AppRow } | { kind: "not_found" };

/** EditShow's load half (oauth2_common.go:91-106): load by id; the UID
 *  mismatch takes the same NotFound (existence stays hidden either way). */
export async function showOauth2Application(d1: D1Database, ownerId: number, id: number): Promise<ShowOauth2AppResult> {
  const app = await getOAuth2ApplicationById(d1, id);
  if (app === null || app.uid !== ownerId) {
    return { kind: "not_found" };
  }
  return { kind: "ok", app };
}

export type SaveOauth2AppResult =
  | { kind: "saved"; row: OAuth2AppRow }
  | { kind: "invalid"; message: string }
  | { kind: "not_found" }
  | { kind: "locked" };

/**
 * EditSave's write half (oauth2_common.go:109-147) — the WEB contract: the
 * model update overwrites name/redirect_uris/flags and NEVER touches the
 * client secret (models/auth/oauth2.go:321-352; see the module header for
 * the API-PATCH divergence). The builtin lock (:330-334) refuses the five
 * pre-registered client IDs. The landed rotating service is deliberately
 * NOT used here (import-only + wrong contract for the web arm).
 */
export async function saveOauth2ApplicationFromForm(
  d1: D1Database,
  ownerId: number,
  id: number,
  form: OAuth2AppEditForm,
  now: Date = new Date(),
): Promise<SaveOauth2AppResult> {
  const bindError = validateOauth2ApplicationForm(form);
  if (bindError !== null) {
    return { kind: "invalid", message: bindError };
  }
  const existing = await getOAuth2ApplicationById(d1, id);
  if (existing === null || existing.uid !== ownerId) {
    return { kind: "not_found" };
  }
  if (isBuiltinOauth2Application(existing.clientId)) {
    return { kind: "locked" }; // oauth2.go:330-334
  }
  const updated = await drizzle(d1)
    .update(oauth2Applications)
    .set({
      name: form.name,
      confidentialClient: form.confidentialClient,
      skipSecondaryAuthorization: form.skipSecondaryAuthorization,
      redirectUris: JSON.stringify(splitRedirectUris(form.redirectUrisRaw)),
      updatedAt: now,
    })
    .where(eq(oauth2Applications.id, id))
    .returning();
  return { kind: "saved", row: updated[0]! };
}

export type RegenerateOauth2SecretResult =
  | { kind: "ok"; app: OAuth2AppRow; secret: string }
  | { kind: "not_found" };

/**
 * RegenerateSecret (oauth2_common.go:150-174) over GenerateClientSecret
 * (oauth2.go:213-224): the landed generator returns (plaintext, hash); the
 * persistence here covers ONLY the client_secret column
 * (`Cols("client_secret")`, oauth2.go:221 — no updated_unix touch). No
 * builtin lock (upstream's RegenerateSecret has none — the module header).
 */
export async function regenerateOauth2ApplicationSecret(
  d1: D1Database,
  ownerId: number,
  id: number,
  now: Date = new Date(),
): Promise<RegenerateOauth2SecretResult> {
  const app = await getOAuth2ApplicationById(d1, id);
  if (app === null || app.uid !== ownerId) {
    return { kind: "not_found" };
  }
  const { plaintext, hash } = await generateClientSecret();
  const updated = await drizzle(d1)
    .update(oauth2Applications)
    .set({ clientSecret: hash, updatedAt: now })
    .where(eq(oauth2Applications.id, id))
    .returning();
  return { kind: "ok", app: updated[0]!, secret: plaintext };
}

export type CreateOauth2AppResult =
  | { kind: "created"; row: OAuth2AppRow; secret: string }
  | { kind: "invalid"; message: string };

/**
 * AddApp's write half (oauth2_common.go:56-88) over the landed create: the
 * binder (see validateOauth2ApplicationForm), then CreateOAuth2Application +
 * GenerateClientSecret — the UUID client_id, the gto_-prefixed secret
 * stored as a HASH and returned as plaintext exactly once. The service's
 * insert-failure ApiError propagates (upstream's ServerError arm).
 */
export async function createOauth2ApplicationFromForm(
  d1: D1Database,
  ownerId: number,
  form: OAuth2AppEditForm,
  now: Date = new Date(),
): Promise<CreateOauth2AppResult> {
  const bindError = validateOauth2ApplicationForm(form);
  if (bindError !== null) {
    return { kind: "invalid", message: bindError };
  }
  const { row, secret } = await createOAuth2Application(
    d1,
    {
      uid: ownerId,
      name: form.name,
      redirectUris: splitRedirectUris(form.redirectUrisRaw),
      confidentialClient: form.confidentialClient,
      skipSecondaryAuthorization: form.skipSecondaryAuthorization,
    },
    now,
  );
  return { kind: "created", row, secret };
}

export type DeleteOauth2AppResult = { kind: "deleted" } | { kind: "not_found" } | { kind: "locked" };

/**
 * DeleteApp's write half (oauth2_common.go:177-193): load by id (NO uid
 * check — upstream loads bare and lets the (id, uid) delete answer the
 * ownership pair, oauth2.go:386-401), the builtin lock (:391-396), then the
 * landed (id, uid) delete. Miss and lock both answer the 404 shell (the
 * landed family's divergence — upstream ServerErrors both; the module
 * header).
 */
export async function deleteOauth2ApplicationFromForm(d1: D1Database, ownerId: number, id: number): Promise<DeleteOauth2AppResult> {
  const app = await getOAuth2ApplicationById(d1, id);
  if (app === null) {
    return { kind: "not_found" };
  }
  if (isBuiltinOauth2Application(app.clientId)) {
    return { kind: "locked" };
  }
  const deleted = await deleteOAuth2Application(d1, id, ownerId);
  return deleted ? { kind: "deleted" } : { kind: "not_found" };
}

// ---------------------------------------------------------------------------
// The gate's 403 body (web.go:373-378's oauth2Enabled → ctx.HTTPError(403) —
// the same bytes the landed provider group wrap answers: net/http
// http.Error's "Forbidden\n", text/plain WITH the space, nosniff)
// ---------------------------------------------------------------------------

export function oauth2SettingsForbidden(): Response {
  return new Response("Forbidden\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// The render (applications_oauth2_edit_form.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The edit page's render inputs. `clientSecret` is the once-only plaintext
 *  on the create/regenerate re-renders, "" on a plain show (the masked
 *  placeholder field renders instead). `form` re-renders the submitted
 *  values on the save-error arm. */
export interface OAuth2AppEditPageData {
  app: OAuth2AppRow;
  clientSecret: string;
  formActionPath: string;
  form: OAuth2AppEditForm;
  error: string | null;
}

/** Assemble the render inputs for a plain show (the EditShow arm: the stored
 *  values re-rendered, no secret). The save-error arm passes the kept
 *  submission through `form` instead. */
export function oauth2AppEditPageData(app: OAuth2AppRow, formActionPath: string, error: string | null = null): OAuth2AppEditPageData {
  return {
    app,
    clientSecret: "",
    formActionPath,
    form: {
      name: app.name,
      redirectUrisRaw: (JSON.parse(app.redirectUris) as string[]).join("\n"),
      confidentialClient: app.confidentialClient,
      skipSecondaryAuthorization: app.skipSecondaryAuthorization,
    },
    error,
  };
}

/** The form segment — applications_oauth2_edit_form.tmpl's exact section
 *  stack: the h4 header, the description segment, the credentials segment
 *  (client id + the secret's shown-once/masked pair + the regenerate item),
 *  the bottom save segment. */
export function Oauth2AppEditFormSegment(props: { data: OAuth2AppEditPageData }) {
  const { data } = props;
  const uris = (JSON.parse(data.app.redirectUris) as string[]).join("\n");
  return (
    <>
      {data.error !== null ? <div class="ui negative message">{data.error}</div> : null}
      <h4 class="ui top attached header">{oauth2AppEditLocale.edit_oauth2_application}</h4>
      <div class="ui attached segment">
        <p>{oauth2AppEditLocale.create_description}</p>
      </div>
      <div class="ui attached segment form ignore-dirty">
        <div class="field">
          <label for="client-id">{oauth2AppEditLocale.client_id}</label>
          <input id="client-id" readonly value={data.app.clientId} />
        </div>
        {data.clientSecret !== "" ? (
          // edit_form.tmpl:12-16 — the shown-once arm.
          <div class="field">
            <label for="client-secret">{oauth2AppEditLocale.client_secret}</label>
            <input id="client-secret" type="text" readonly value={data.clientSecret} />
          </div>
        ) : (
          // edit_form.tmpl:17-22 — the masked placeholder (verbatim value).
          <div class="field">
            <label for="client-secret">{oauth2AppEditLocale.client_secret}</label>
            <input id="client-secret" type="password" readonly value={oauth2AppEditLocale.masked_secret_placeholder} />
          </div>
        )}
        <div class="item">
          {/* edit_form.tmpl:23-29 — the regenerate item. */}
          <form class="ui form ignore-dirty" action={`${data.formActionPath}/regenerate_secret`} method="post">
            {oauth2AppEditLocale.regenerate_secret_hint}
            <button class="ui mini button tw-ml-2" type="submit">
              {oauth2AppEditLocale.regenerate_secret}
            </button>
          </form>
        </div>
      </div>
      <div class="ui bottom attached segment">
        <form class="ui form ignore-dirty" action={data.formActionPath} method="post">
          <div class="field">
            <label for="application-name">{oauth2AppEditLocale.application_name}</label>
            <input id="application-name" value={data.form.name} name="application_name" required maxlength={255} />
          </div>
          <div class="field">
            <label for="redirect-uris">{oauth2AppEditLocale.redirect_uris}</label>
            <textarea name="redirect_uris" id="redirect-uris" required>
              {uris}
            </textarea>
          </div>
          <div class="field">
            <div class="ui checkbox">
              <label>{oauth2AppEditLocale.confidential_client}</label>
              <input type="checkbox" name="confidential_client" checked={data.app.confidentialClient ? true : undefined} />
            </div>
          </div>
          <div class={data.app.confidentialClient ? "field disabled" : "field"} id="skip-secondary-authorization">
            {/* edit_form.tmpl:47 — the field div carries the `disabled` class
                while the confidential flag is on (the JS live-toggle's
                server-rendered state; the DOM is upstream's exact shape). */}
            <div class="ui checkbox">
              <label>{oauth2AppEditLocale.skip_secondary_authorization}</label>
              <input type="checkbox" name="skip_secondary_authorization" checked={data.app.skipSecondaryAuthorization ? true : undefined} />
            </div>
          </div>
          <button type="submit" class="ui primary button">
            {oauth2AppEditLocale.save_application}
          </button>
        </form>
      </div>
    </>
  );
}

// --- the three chromes (the twins' layout templates) -------------------------

/**
 * The USER twin (user/settings/applications_oauth2_edit.tmpl): the settings
 * layout with pageClass "user settings applications" (the applications
 * page's own dict, :1) and the Applications tab active. The document title
 * carries the app name — upstream's show arms set no Title and inherit the
 * site default; the house BaseLayout needs the title for the a11y R3
 * aria-label (the oauth2-grant page's recorded divergence, reused).
 */
export function renderUserOauth2AppEditPage(ctx: UiContext, data: OAuth2AppEditPageData): string {
  return renderPage(
    <BaseLayout ctx={ctx} title={data.app.name} pageClass="user settings applications">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="applications" />
        <div class="user-setting-content">
          <Oauth2AppEditFormSegment data={data} />
        </div>
      </div>
    </BaseLayout>,
  );
}

/**
 * The ORG twin (org/settings/applications_oauth2_edit.tmpl): the org layout
 * with the OPTIONS pageClass quirk (org/settings/applications.tmpl:1's
 * literal dict — the landed org page's documented quirk, kept), the OrgHeader
 * and the settings navbar with the Applications item active.
 */
export function renderOrgOauth2AppEditPage(ctx: UiContext, org: OrgRecord, data: OAuth2AppEditPageData, signedIn: boolean): string {
  const orgLink = `/${org.username}`;
  return renderPage(
    <BaseLayout ctx={ctx} title={data.app.name} pageClass="organization settings options">
      <OrgHeader org={org} signedIn={signedIn} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="applications" />
        <div class="flex-container-main">
          <div class="org-setting-content">
            <Oauth2AppEditFormSegment data={data} />
          </div>
        </div>
      </div>
    </BaseLayout>,
  );
}

/**
 * The ADMIN twin (admin/applications/oauth2_edit.tmpl): the admin layout
 * with pageClass "admin config" (list.tmpl:1's dict) and the Applications
 * nav item active. The document title carries the app name like the
 * user/org variants (the a11y R3 aria-label slot).
 */
export function renderAdminOauth2AppEditPage(ctx: UiContext, data: OAuth2AppEditPageData): string {
  return renderPage(
    <AdminFamilyShell ctx={ctx} title={data.app.name} pageClass="admin config" active="applications">
      <Oauth2AppEditFormSegment data={data} />
    </AdminFamilyShell>,
  );
}
