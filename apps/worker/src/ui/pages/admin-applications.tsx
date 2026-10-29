/**
 * The ADMIN APPLICATIONS page — `/-/admin/applications` — the census R18
 * (a) applications arm ("global oauth2 applications — a read over the
 * landed `oauth2Applications` table — upstream admin applications is the
 * instance-wide app list"): the route lives in `index.ts`'s admin literal
 * family block. NOTE the census's N/A call is the AUTHS arm (single auth
 * method), not this one — applications is (a) and LANDED here.
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/applications/list.tmpl` (which embeds the SHARED
 * `user/settings/applications_oauth2_list` template) served by
 * `admin.Applications` (routers/web/admin/applications.go:34-52), route
 * `GET /-/admin/applications` (web.go:865-872's `/applications` group
 * `m.Get("")`, gated web.go:779's SignInRequired + AdminRequired — the
 * shared adminPagePrologue posture). The handler's read is
 * `db.Find(OAuth2ApplicationsOptions{IsGlobal: true})` — the UID=0
 * instance-wide rows ONLY (models/auth/oauth2_list.go:22-23:
 * `IsGlobal → builder.Eq{"uid": 0}`), id DESC (ToOrders), NO pagination on
 * the web list.
 *
 * The group's writes upstream: `POST /oauth2` (ApplicationsPost → the
 * shared OAuth2CommonHandlers.AddApp with Owner nil — uid 0), the
 * `/oauth2/{id}` edit family (EditShow/EditPost/RegenerateSecret) and
 * `POST /oauth2/{id}/delete` (DeleteApp). LANDED here: the create and the
 * delete; the edit/regenerate pages are UNLANDED (the OAuth2 store's only
 * landed web surfaces before this wave were none — the user-settings
 * applications page pins the PAT panel and omits the oauth2 half, its
 * module header's first reduction), so the list rows' Edit buttons are
 * OMITTED (the dead-link rule) and the Remove button rides the landed
 * delete.
 *
 * ## The global-uid model on cf-gitea
 *
 * The landed `oauth2_application` table carries upstream's `UID` column
 * with NO foreign key (schema.ts), so uid=0 — upstream's global sentinel —
 * is representable and only ever populated HERE (the API family
 * routes/oauth2-apps.ts is doer-scoped: every /user/applications/oauth2 op
 * keys on the caller's id; the user-settings web page doesn't write the
 * store at all). The page is therefore the ONLY producer and the ONLY
 * consumer of the instance-wide rows — exactly upstream's shape.
 *
 * ## Data (§3.2 — the landed oauth2 service, never a self-fetch)
 *
 *   list    `listOAuth2Applications(d1, 0, …)` (services/oauth2-apps.ts —
 *           upstream's ToConds port: eq(uid), id DESC) LOOPED to the render
 *           bound (upstream lists all rows; the loop walks the service's
 *           pagination until the total is drained, capped at
 *           ADMIN_APPLICATIONS_LIST_LIMIT — the render-bound convention).
 *   create  `createOAuth2Application` (CreateOAuth2Application, oauth2.go —
 *           the service generates the client id + the gto_-prefixed secret,
 *           stores the HASH, returns the plaintext once) with uid=0;
 *           `detectInvalidOAuth2ApplicationRedirectURI` is the form's
 *           redirect-URI validation (forms.DetectInvalidOAuth2Application
 *           RedirectURI port — the API family's exact arm). The redirect
 *           URIs ride the textarea one-per-line
 *           (`util.SplitTrimSpace(form.RedirectURIs, "\n")` —
 *           oauth2_common.go:69).
 *   delete  `deleteOAuth2Application(d1, id, 0)` — the (id, uid) delete;
 *           false is the unknown/foreign arm → the 404 shell (upstream
 *           NotFound on the same miss, oauth2_common.go:186-192).
 *
 * ## Write-answer reductions (the no-flash posture)
 *
 *   - create invalid (blank name / a rejected redirect URI): re-render the
 *     FULL page at 200 with the error line + the submitted values (the
 *     org-team-new RenderWithErr arm; upstream flashes and redirects to the
 *     list).
 *   - create success: upstream renders the EDIT page with the plaintext
 *     secret + the create_oauth2_application_success flash
 *     (oauth2_common.go:79-86); with no landed edit page the honest no-JS
 *     analog is the FULL LIST re-rendered with the once-only secret line
 *     (the user-settings newToken precedent — the plaintext renders exactly
 *     once, SPEC-wise the store keeps the hash only).
 *   - delete success/miss: 303 back / the 404 shell (above).
 *
 * ## Mount record (MOUNTED this wave — the routes are live)
 *
 *   GET  /-/admin/applications                    the list (prologue → load
 *                                                 → render at 200)
 *   POST /-/admin/applications/oauth2             the create (guard +
 *                                                 prologue → form →
 *                                                 create/re-render)
 *   POST /-/admin/applications/oauth2/{id}/delete the delete (guard +
 *                                                 prologue → 303 / 404)
 *
 * All claims sit in the landed admin literal family block (static literals;
 * the `{id}` is the positive-integer param — the landed DELETE arm's
 * PathParamInt64 posture). The unlanded `/oauth2/{id}` GET/POST edit shapes
 * stay unclaimed → the engine's 404, exactly upstream's unregistered-route
 * answer. The family navbar gains the Integrations group with the
 * Applications item (upstream navbar.tmpl order: Applications BEFORE
 * Webhooks).
 */

import { createOAuth2Application, deleteOAuth2Application, detectInvalidOAuth2ApplicationRedirectURI, listOAuth2Applications, toApiOAuth2Application, type OAuth2AppRow } from "../../api/services/oauth2-apps";
import type { UiContext } from "../ui-context";
import { AdminEmbeddedSvg, AdminFamilyShell } from "./admin-users";
import { renderPage } from "../shell";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminApplicationsLocale = {
  applications: "Applications", // "settings.applications" (the title + the nav item; applications.go:38)
  create_description:
    "OAuth2 applications give your third-party application access to user accounts on this instance.", // "settings.oauth2_application_create_description" (list.tmpl:7)
  client_id: "Client ID", // "settings.oauth2_client_id"
  edit: "Edit", // "settings.oauth2_application_edit" (the omitted Edit button's key — cited)
  remove: "Remove", // "remove" (the Remove button, list's trash button label)
  remove_confirm: "Removing an OAuth2 application will prevent it from accessing authorized user accounts on this instance. Continue?", // "settings.oauth2_application_remove_description" (the remove button's aria — the confirm-dialog reduction)
  create_oauth2_application: "Create a new OAuth2 Application", // "settings.create_oauth2_application" (the details summary)
  create_oauth2_application_button: "Create Application", // "settings.create_oauth2_application_button"
  create_success: "You have successfully created a new OAuth2 application.", // "settings.create_oauth2_application_success"
  application_name: "Application Name", // "settings.oauth2_application_name"
  redirect_uris: "Redirect URIs. Please use a new line for every URI.", // "settings.oauth2_redirect_uris" (strong stripped)
  confidential_client:
    "Confidential Client. Select for apps that keep the secret confidential, such as web apps. Do not select for native apps, including desktop and mobile apps.", // "settings.oauth2_confidential_client"
  skip_secondary_authorization:
    "Skip authorization for public clients after granting access once. May pose a security risk.", // "settings.oauth2_skip_secondary_authorization" (strong stripped)
  client_secret_hint: "The secret will not be shown again after you leave or refresh this page. Please ensure that you have saved it.", // "settings.oauth2_client_secret_hint"
  error_name_required: "Name cannot be empty.", // the required-name bind arm (forms' Required binding → the re-render error)
  error_redirect_uri: "Invalid redirect URI.", // the DetectInvalid arm's generic line (the exact URI rides the browser log upstream)
  no_apps: "No applications yet", // the empty-list arm (upstream's {{range}} renders none; the explicit line is the settings pages' cf-gitea convention)
} as const;

/** The render bound over the NO-pager upstream list: the loop walks the
 *  service's pages until the total drains, capped here (the
 *  HOOKS_LIST_LIMIT convention). */
export const ADMIN_APPLICATIONS_LIST_LIMIT = 500;
const SERVICE_PAGE_SIZE = 100;

/** The list page's render inputs: the uid=0 rows, id DESC (the service's
 *  order) — plus the once-only secret pair from a just-served create. */
export interface AdminApplicationsData {
  apps: OAuth2AppRow[];
  /** The create flow's once-only plaintext (empty outside the create
   *  re-render — the module header's secret note), with its client id. */
  newClientSecret: string;
  newClientId: string;
  form: AdminApplicationCreateForm;
  error: string | null;
}

export interface AdminApplicationCreateForm {
  name: string;
  redirectUrisRaw: string;
  confidentialClient: boolean;
  skipSecondaryAuthorization: boolean;
}

export function parseAdminApplicationCreateForm(form: URLSearchParams): AdminApplicationCreateForm {
  const textarea = form.get("redirect_uris") ?? "";
  return {
    name: (form.get("application_name") ?? "").trim(),
    redirectUrisRaw: textarea,
    // The checkbox tri-state: present+non-empty = checked (the HTML form
    // contract; upstream's web.FormBool).
    confidentialClient: (form.get("confidential_client") ?? "") !== "",
    skipSecondaryAuthorization: (form.get("skip_secondary_authorization") ?? "") !== "",
  };
}

/** `util.SplitTrimSpace(form.RedirectURIs, "\n")` (oauth2_common.go:69). */
export function splitRedirectUris(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The list load — Applications' IsGlobal read over the landed service,
 * looped to the render bound (the module header): uid=0 only, id DESC.
 */
export async function loadAdminApplicationsData(d1: D1Database): Promise<AdminApplicationsData> {
  const apps: OAuth2AppRow[] = [];
  let page = 1;
  for (;;) {
    const { rows, total } = await listOAuth2Applications(d1, 0, page, SERVICE_PAGE_SIZE);
    apps.push(...rows);
    if (apps.length >= Math.min(total, ADMIN_APPLICATIONS_LIST_LIMIT) || rows.length < SERVICE_PAGE_SIZE) break;
    page += 1;
  }
  return {
    apps,
    newClientSecret: "",
    newClientId: "",
    form: { name: "", redirectUrisRaw: "", confidentialClient: true, skipSecondaryAuthorization: false },
    error: null,
  };
}

export type AdminApplicationCreateOutcome =
  | { kind: "created"; data: AdminApplicationsData }
  | { kind: "invalid"; data: AdminApplicationsData };

/**
 * ApplicationsPost → AddApp (oauth2_common.go:56-86) over the landed
 * service: the required-name bind, the redirect-URI validation, the uid=0
 * create, then the once-only secret rendered on the re-rendered list (the
 * module header's reduction). The outcome carries the FULL re-render model
 * either way — the caller answers 200 with it.
 */
export async function applyAdminApplicationCreate(
  d1: D1Database,
  form: AdminApplicationCreateForm,
): Promise<AdminApplicationCreateOutcome> {
  const base = await loadAdminApplicationsData(d1);
  if (form.name === "") {
    return { kind: "invalid", data: { ...base, form, error: adminApplicationsLocale.error_name_required } };
  }
  const uris = splitRedirectUris(form.redirectUrisRaw);
  const invalid = detectInvalidOAuth2ApplicationRedirectURI(uris);
  if (invalid !== "") {
    return { kind: "invalid", data: { ...base, form, error: adminApplicationsLocale.error_redirect_uri } };
  }
  const { row, secret } = await createOAuth2Application(
    d1,
    {
      uid: 0,
      name: form.name,
      redirectUris: uris,
      confidentialClient: form.confidentialClient,
      skipSecondaryAuthorization: form.skipSecondaryAuthorization,
    },
    new Date(),
  );
  const fresh = await loadAdminApplicationsData(d1);
  return {
    kind: "created",
    data: {
      ...fresh,
      newClientSecret: secret,
      newClientId: row.clientId,
      form,
      error: null,
      apps: [row, ...fresh.apps.filter((app) => app.id !== row.id)],
    },
  };
}

export interface AdminApplicationDeleteForm {
  id: number;
}

export function parseAdminApplicationDeleteForm(form: URLSearchParams): AdminApplicationDeleteForm {
  return { id: Number.parseInt(form.get("id") ?? "0", 10) || 0 };
}

/**
 * DeleteApp's write half — the (id, uid=0) delete; false is the
 * unknown/foreign arm the caller answers with the 404 shell.
 */
export async function applyAdminApplicationDelete(d1: D1Database, id: number): Promise<boolean> {
  return deleteOAuth2Application(d1, id, 0);
}

// ---------------------------------------------------------------------------
// The render (admin/applications/list.tmpl × user/settings/
// applications_oauth2_list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderAdminApplicationsPage(ctx: UiContext, data: AdminApplicationsData): string {
  return renderPage(<AdminApplicationsPage ctx={ctx} data={data} />);
}

/** The admin applications page (§2.4.1 discriminator: `admin config` — the
 *  template's own dict, list.tmpl:1; upstream Title is
 *  ctx.Tr "settings.applications"). */
export function AdminApplicationsPage(props: { ctx: UiContext; data: AdminApplicationsData }) {
  const { data } = props;
  return (
    <AdminFamilyShell
      ctx={props.ctx}
      title={adminApplicationsLocale.applications}
      pageClass="admin config"
      active="applications"
    >
      <h4 class="ui top attached header">{adminApplicationsLocale.applications}</h4>
      {data.newClientSecret !== "" ? (
        // The create flow's once-only secret (the user-settings newToken
        // precedent): the positive message + the client id + the plaintext
        // code + the hint.
        <div class="ui positive message">
          <p>{adminApplicationsLocale.create_success}</p>
          <p>
            {adminApplicationsLocale.client_id}: <code class="new-oauth2-client-id">{data.newClientId}</code>
          </p>
          <div class="ui segment">
            <code id="new-oauth2-client-secret">{data.newClientSecret}</code>
          </div>
          <p>{adminApplicationsLocale.client_secret_hint}</p>
        </div>
      ) : null}
      {data.error !== null ? (
        <div class="ui negative message">
          <p>{data.error}</p>
        </div>
      ) : null}
      <div class="ui attached segment">
        <div class="flex-divided-list items-with-main">
          <div class="item">
            {/* list.tmpl:6's description line. */}
            {adminApplicationsLocale.create_description}
          </div>
          {data.apps.length === 0 ? (
            <div class="item">{adminApplicationsLocale.no_apps}</div>
          ) : (
            data.apps.map((app) => {
              // toApiOAuth2Application is the render's client-id/uris
              // projection (the JSON.parse of the redirect_uris TEXT — the
              // service's contract; the secret arg is the list's "" blank,
              // app.go's hide-on-list arm).
              const view = toApiOAuth2Application(app, "");
              return (
                <div class="item tw-items-center" key={app.id}>
                  <div class="item-leading">
                    <AdminEmbeddedSvg name="octicon-apps" size={32} />
                  </div>
                  <div class="item-main">
                    <div class="item-title">{view.name}</div>
                    <div class="item-body">
                      {adminApplicationsLocale.client_id}
                      <span class="ui label"> {view.client_id}</span>
                    </div>
                  </div>
                  <div class="item-trailing">
                    {/* The Edit button (unlanded edit page) is OMITTED — the
                        dead-link rule; the BuiltinApplications "locked" arm
                        is unreachable (no pre-registered apps in this
                        store). The Remove button rides the landed delete —
                        the plain-form POST (the confirm-dialog reduction;
                        the desc text is the aria label). */}
                    <form method="post" action={`/-/admin/applications/oauth2/${app.id}/delete`} class="tw-inline">
                      <input type="hidden" name="id" value={String(app.id)} />
                      <button type="submit" class="ui red tiny button link-action negative" aria-label={adminApplicationsLocale.remove_confirm}>
                        {adminApplicationsLocale.remove}
                      </button>
                    </form>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* The create segment (list.tmpl's bottom attached segment): the
          details stays CLOSED when apps exist, OPEN on the empty/after-error
          arms (the template's `{{if .application_name}}open{{end}}` shape —
          the submitted name is our error-marker). */}
      <div class="ui bottom attached segment">
        <details open={data.error !== null || data.apps.length === 0 ? true : undefined}>
          <summary>
            <h4 class="ui header tw-inline-block tw-my-2">{adminApplicationsLocale.create_oauth2_application}</h4>
          </summary>
          <form class="ui form" action="/-/admin/applications/oauth2" method="post">
            <div class="field">
              <label for="application-name">{adminApplicationsLocale.application_name}</label>
              <input id="application-name" name="application_name" value={data.form.name} required maxlength={255} />
            </div>
            <div class="field">
              <label for="redirect-uris">{adminApplicationsLocale.redirect_uris}</label>
              <textarea name="redirect_uris" id="redirect-uris">
                {data.form.redirectUrisRaw}
              </textarea>
            </div>
            <div class="field">
              <div class="ui checkbox">
                <label>{adminApplicationsLocale.confidential_client}</label>
                <input type="checkbox" name="confidential_client" checked={data.form.confidentialClient ? true : undefined} />
              </div>
            </div>
            <div class="field">
              <div class="ui checkbox">
                <label>{adminApplicationsLocale.skip_secondary_authorization}</label>
                <input type="checkbox" name="skip_secondary_authorization" checked={data.form.skipSecondaryAuthorization ? true : undefined} />
              </div>
            </div>
            <button type="submit" class="ui primary button">
              {adminApplicationsLocale.create_oauth2_application_button}
            </button>
          </form>
        </details>
      </div>
    </AdminFamilyShell>
  );
}
