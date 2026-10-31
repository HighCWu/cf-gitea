/**
 * The org settings APPLICATIONS tab — the census R20 (a) arm: upstream
 * web.go:1027-1037's `/applications` group inside the require-owner
 * `/{org}/settings` subtree (`GET org.Applications` + `POST web.Bind
 * [*forms.EditOAuth2ApplicationForm] org.OAuthApplicationsPost` + the
 * `/oauth2/{id}` family whose `POST /oauth2/{id}/delete` deletes) over
 * `gitea/templates/org/settings/applications.tmpl` — which embeds the SHARED
 * `user/settings/applications_oauth2_list.tmpl` (the exact template the
 * admin applications page and the user-settings oauth2 half render). The
 * handler reads `db.Find[auth.OAuth2Application]` with
 * `FindOAuth2ApplicationsOptions{OwnerID: ctx.Org.Organization.ID}`
 * (setting_oauth2.go:34-54) — the org-OWNED rows, owner id = the org's id;
 * the writes ride the shared `OAuth2CommonHandlers` constructed with
 * `Owner: org.Organization.AsUser()` (setting_oauth2.go:24-31), so
 * `oa.ownerID()` is the org's id too (oauth2_common.go:28-33).
 *
 * THE owner/admin family like every org settings page: the shared org-teams
 * prologue answers exactly the landed org-settings posture — anonymous 303s
 * onto the login round-trip, a signed-in non-owner 404-shells (upstream's
 * RequireOwner OrgAssignment NotFound, web.go:1039-1041), a renamed org 307s.
 * Upstream additionally wraps the group in `oauth2Enabled` (web.go:373-379 —
 * 403 while `setting.OAuth2.Enabled` is false) and gates the navbar item on
 * `.EnableOAuth2` (navbar.tmpl:14-19); cf-gitea's OAuth2 store is
 * unconditional (no settings seam — the landed service), so the arm always
 * serves (documented divergence).
 *
 * ## Data (§3.2 — the landed oauth2 service, never a self-fetch)
 *
 * The service (`api/services/oauth2-apps.ts` — upstream
 * models/auth/oauth2.go CRUD over migration 0026's `oauth2_application`)
 * is uid-PARAMETERIZED by design: `uid` is upstream's owner-id column and
 * the org's user row shares the id space (the census row's "org rows use
 * the same column upstream"). The org-scope arms are therefore the service
 * functions with `uid = org.id` — no service change:
 *
 *   list    `listOAuth2Applications(d1, org.id, …)` (FindOAuth2Applications
 *           Options' OwnerID arm, oauth2_list.go:12-33 — uid filter, id
 *           DESC) LOOPED to the render bound (upstream's web GET renders
 *           the list unpaginated; the loop walks the service's pagination
 *           until the total drains, capped at ORG_APPLICATIONS_LIST_LIMIT —
 *           the ADMIN_APPLICATIONS_LIST_LIMIT convention).
 *   create  `createOAuth2Application(d1, {uid: org.id, …})`
 *           (CreateOAuth2Application + GenerateClientSecret — UUID
 *           client_id, the gto_-prefixed secret stored as a HASH and
 *           returned as plaintext exactly once); the form's redirect URIs
 *           ride `detectInvalidOAuth2ApplicationRedirectURI` (the web
 *           binder's Validate arm, user_form.go:256-273) and the textarea
 *           splits per `util.SplitTrimSpace(form.RedirectURIs, "\n")`
 *           (oauth2_common.go:69).
 *   delete  `deleteOAuth2Application(d1, id, org.id)` — the (id, uid)
 *           delete (oauth2.go:386-401); false is the unknown/foreign arm →
 *           the 404 shell (the org hooks-page delete convention and the
 *           admin page's identical posture; upstream's DeleteApp
 *           ServerErrors a miss instead — oauth2_common.go:184-187 — the
 *           documented divergence, existence stays hidden either way).
 *
 * The uid=org.id ISOLATION is structural: every arm keys the where-clause
 * on the org's id, so a user-owned application (uid = some user's id) never
 * appears in the list and never satisfies the delete's (id, uid) pair.
 *
 * ## Write-answer reductions (the no-flash posture)
 *
 *   - create invalid (blank name / a rejected redirect URI): re-render the
 *     FULL page at 200 with the error line + the submitted values (the
 *     org-team-new RenderWithErr arm; upstream's AddApp flashes the bind
 *     error and redirects to the list, oauth2_common.go:58-63).
 *   - create success: upstream renders the EDIT page with the plaintext
 *     secret + the create_oauth2_application_success flash
 *     (oauth2_common.go:79-86); with no landed edit page the honest no-JS
 *     analog is the FULL LIST re-rendered with the once-only secret block
 *     (the admin page's exact reduction — the user-settings newToken
 *     precedent: the plaintext renders exactly once, the store keeps the
 *     hash only).
 *   - delete success: 303 back onto the list (upstream's JSONRedirect
 *     target — BasePathList, oauth2_common.go:192; the plain-form-POST +
 *     303 convention where upstream's JS intercepts); miss → the 404 shell
 *     (above).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The per-row Edit button (`{{$.Link}}/oauth2/{{.ID}}` — the shared
 *   list template's primary anchor, applications_oauth2_list.tmpl:23-26)
 *   is OMITTED: the show/edit/regenerate-secret pages (web.go:1031-1035's
 *   `m.Combo("").Get(...).Post(...)` + `POST /regenerate_secret`) have no
 *   landed analog (this brief pins the list + create/delete arms) — a
 *   rendered anchor would be a dead link (the admin page's identical
 *   reduction). Those edit shapes stay UNCLAIMED in the parse → the
 *   engine's 404, exactly upstream's unregistered-route answer.
 * - The BuiltinApplications "locked" label arm
 *   (applications_oauth2_list.tmpl:18-21) renders never: no pre-registered
 *   apps exist in this store (the admin page's note).
 * - The remove confirm dialog (`link-action` + `#remove-gitea-oauth2
 *   -application` modal, applications_oauth2_list.tmpl:27-31, 38-47)
 *   reduces to the plain form POST (the hooks-list reduction): the dialog's
 *   description text rides the button's aria-label (the admin page's
 *   convention), and the trash glyph is the allowlisted octicon-trash.
 * - The leading row glyph `{{svg "octicon-apps" 32}}` is OUTSIDE the
 *   generated icon allowlist — octicon-package is the documented stand-in
 *   (the feeds-glyph convention; a later allowlist extension swaps it per
 *   this one-line site).
 * - The create form's `<details>` reopen condition upstream is the kept
 *   `application_name` (applications_oauth2_list.tmpl:51); the re-render
 *   opens on the error arm OR the empty list (the admin page's shape — the
 *   empty-list open is the template's own UX: a first app's form starts
 *   expanded).
 *
 * ## Mount record (MOUNTED this wave — the routes are live)
 *
 *   GET  /{org}/settings/applications                     the list (the
 *                                                         org-teams
 *                                                         prologue → load
 *                                                         → render at 200)
 *   POST /{org}/settings/applications/oauth2              the create (guard
 *                                                         + prologue → form
 *                                                         → create /
 *                                                         re-render at 200)
 *   POST /{org}/settings/applications/oauth2/{id}/delete  the delete (guard
 *                                                         + prologue → 303
 *                                                         / 404 shell)
 *
 * The settings navbar is the SHARED components/settings-nav
 * OrgSettingsNavbar rendered with `active: "applications"` (the shared
 * component's Applications item — navbar.tmpl:15-19 — lights up with this
 * mount; the a43d9b1 dead-link omission is retired). The page Title is
 * settings.applications ("Applications" — org/setting_oauth2.go:35, the
 * same text the h4 renders).
 *
 * ## W5 (2026-10-31) — the edit/regenerate arms + the upstream create answer
 * (specs/oauth2-provider.md §6 W5's OQ2 resolution: the landed brief's
 * "edit shapes stay UNCLAIMED" note staged them for exactly this wave — the
 * upstream org twin carries the full family, web.go:1025-1029's
 * `m.Combo("").Get(org.OAuth2ApplicationShow).Post(... org.OAuth2ApplicationEdit)`
 * + `POST /regenerate_secret`, setting_oauth2.go:66-93)
 *
 *   - The per-row Edit button RENDERS now (applications_oauth2_list.tmpl:23-26
 *     verbatim) → the shared edit page (pages/oauth2-app-edit.tsx — the
 *     OAuth2CommonHandlers port; the org variant renders this page's chrome
 *     with the edit-form segment). The parse-tree claims ride the W5 handoff
 *     (ui/index.ts): GET/POST /{org}/settings/applications/oauth2/{id} and
 *     POST .../{id}/regenerate_secret, all inside the landed applications
 *     group's `oauth2Enabled` gate (web.go:1030 — the group wrap answers
 *     oauth2SettingsForbidden's 403 when OAUTH2_ENABLED=false; the landed
 *     "the arm always serves" divergence above retires with the W4 seam).
 *   - The create answer upgrades to upstream's AddApp shape: the EDIT PAGE
 *     rendered with the once-only plaintext secret (oauth2_common.go:79-87)
 *     — the list re-render that stood in ("with no landed edit page",
 *     above) retires; the create/write arms now go through the shared
 *     module's form+binder (validateOauth2ApplicationForm — adding the
 *     Required redirect_uris bind arm and the exact `RedirectURIs: "<uri>"
 *     is not a valid URL.` composite the generic reductions approximated).
 *   - The once-only secret block leaves THIS list page (it was the edit
 *     page's stand-in); the data model drops newClientSecret/newClientId.
 *
 * The uid=org.id isolation is untouched (the shared arms key on ownerId
 * the same way); the builtin lock is unreachable on org rows (builtins are
 * uid=0) but the shared delete/edit arms carry it anyway (upstream's model
 * lock applies to every twin).
 */

import { listOAuth2Applications, toApiOAuth2Application, type OAuth2AppRow } from "../../api/services/oauth2-apps";
import {
  createOauth2ApplicationFromForm,
  deleteOauth2ApplicationFromForm,
  parseOauth2AppEditForm,
  splitRedirectUris as splitRedirectUrisShared,
  type OAuth2AppEditForm,
} from "./oauth2-app-edit";
import type { OrgRecord } from "../../services/orgs/orgs";
import type { IconName } from "../icons";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { OrgSettingsNavbar } from "../components/settings-nav";
import { OrgHeader } from "./org-home";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern; upstream en-US values at
// the pin, keys cited — the SHARED template's keys, the same values the
// admin applications page renders)
// ---------------------------------------------------------------------------

export const orgSettingsApplicationsLocale = {
  /** The navbar tab, the page Title (setting_oauth2.go:35) and the h4
   *  (org/settings/applications.tmpl:3-5). */
  applications: "Applications", // "settings.applications"
  create_description:
    "OAuth2 applications give your third-party application access to user accounts on this instance.", // "settings.oauth2_application_create_description" (the list's first item)
  client_id: "Client ID", // "settings.oauth2_client_id"
  remove: "Remove", // "remove" (the Remove button's label)
  remove_confirm:
    "Removing an OAuth2 application will prevent it from accessing authorized user accounts on this instance. Continue?", // "settings.oauth2_application_remove_description" (the confirm-dialog reduction's aria)
  no_apps: "No applications yet", // the empty-list arm (upstream's {{range}} renders none; the explicit line is the settings pages' cf-gitea convention)
  edit: "Edit", // "settings.oauth2_application_edit" (the W5 row link — the shared edit page)
  create_oauth2_application: "Create a new OAuth2 Application", // "settings.create_oauth2_application" (the details summary)
  application_name: "Application Name", // "settings.oauth2_application_name"
  redirect_uris: "Redirect URIs. Please use a new line for every URI.", // "settings.oauth2_redirect_uris" (strong stripped)
  confidential_client:
    "Confidential Client. Select for apps that keep the secret confidential, such as web apps. Do not select for native apps, including desktop and mobile apps.", // "settings.oauth2_confidential_client"
  skip_secondary_authorization:
    "Skip authorization for public clients after granting access once. May pose a security risk.", // "settings.oauth2_skip_secondary_authorization" (strong stripped)
  create_oauth2_application_button: "Create Application", // "settings.create_oauth2_application_button"
  // The bind-error texts moved to the SHARED binder (oauth2-app-edit.tsx's
  // validateOauth2ApplicationForm — form.require_error "Name cannot be
  // empty." and the exact `RedirectURIs: "<uri>" is not a valid URL.`
  // composite); the former generic "Invalid redirect URI." reduction is
  // retired with the W5 shared binder.
} as const;

/** The leading row glyph stand-in (the module header's reduction note). */
const APP_ICON: IconName = "octicon-package";

/** The render bound over the NO-pager upstream list: the loop walks the
 *  service's pages until the total drains, capped here (the
 *  ADMIN_APPLICATIONS_LIST_LIMIT convention). */
export const ORG_APPLICATIONS_LIST_LIMIT = 500;
const SERVICE_PAGE_SIZE = 100;

/** The create POST body (upstream EditOAuth2ApplicationForm — the shared
 *  shape since W5; this alias keeps the landed export names). */
export type OrgApplicationCreateForm = OAuth2AppEditForm;

export function parseOrgApplicationCreateForm(form: URLSearchParams): OrgApplicationCreateForm {
  return parseOauth2AppEditForm(form);
}

/** `util.SplitTrimSpace(form.RedirectURIs, "\n")` (oauth2_common.go:69) —
 *  the shared module's split since W5. */
export function splitRedirectUris(raw: string): string[] {
  return splitRedirectUrisShared(raw);
}

/** The applications tab's render inputs — the uid=org.id rows (id DESC, the
 *  service's order) and the re-rendered create submission ("" / unchecked on
 *  the plain GET). The W5 once-only secret pair retired: the create answer
 *  is the shared EDIT page (the module header's W5 record), so the list
 *  carries no secret state. */
export interface OrgSettingsApplicationsData {
  org: OrgRecord;
  apps: OAuth2AppRow[];
  form: OrgApplicationCreateForm;
}

/**
 * The list load — Applications' OwnerID read (setting_oauth2.go:39-41) over
 * the landed service, looped to the render bound (the module header):
 * uid=org.id only, id DESC.
 */
export async function loadOrgSettingsApplications(d1: D1Database, org: OrgRecord): Promise<OrgSettingsApplicationsData> {
  const apps: OAuth2AppRow[] = [];
  let page = 1;
  for (;;) {
    const { rows, total } = await listOAuth2Applications(d1, org.id, page, SERVICE_PAGE_SIZE);
    apps.push(...rows);
    if (apps.length >= Math.min(total, ORG_APPLICATIONS_LIST_LIMIT) || rows.length < SERVICE_PAGE_SIZE) break;
    page += 1;
  }
  return {
    org,
    apps,
    form: { name: "", redirectUrisRaw: "", confidentialClient: true, skipSecondaryAuthorization: false },
  };
}

export type OrgApplicationCreateResult =
  | { outcome: "created"; row: OAuth2AppRow; secret: string }
  | { outcome: "invalid"; message: string };

/**
 * OAuthApplicationsPost → AddApp's write half (oauth2_common.go:56-88) —
 * the SHARED create since W5 (uid=org.id): the full binder (name
 * Required/MaxSize, redirect_uris Required, the DetectInvalid URL hook —
 * the shared module's exact composites), then CreateOAuth2Application +
 * GenerateClientSecret. The service's insert-failure ApiError propagates
 * (upstream's ServerError arm — unexpected, not a form error). The caller
 * answers the created arm with the shared EDIT page carrying the once-only
 * secret (the module header's W5 record).
 */
export async function applyOrgApplicationCreate(
  d1: D1Database,
  org: OrgRecord,
  form: OrgApplicationCreateForm,
): Promise<OrgApplicationCreateResult> {
  const result = await createOauth2ApplicationFromForm(d1, org.id, form, new Date());
  if (result.kind === "invalid") {
    return { outcome: "invalid", message: result.message };
  }
  return { outcome: "created", row: result.row, secret: result.secret };
}

/**
 * DeleteApp's write half — the shared delete since W5 (oauth2_common.go:
 * 177-193 over oauth2.go:386-401 + the builtin lock): "deleted" on the hit,
 * "not_found" on the unknown/foreign arm (the caller 404-shells — the
 * module header's divergence note; existence stays hidden). The lock arm is
 * unreachable on uid=org.id rows (builtins are uid=0) but the shared arm
 * carries it for the family.
 */
export async function deleteOrgApplication(
  d1: D1Database,
  org: OrgRecord,
  id: number,
): Promise<{ kind: "deleted" } | { kind: "not_found" } | { kind: "locked" }> {
  return deleteOauth2ApplicationFromForm(d1, org.id, id);
}

// ---------------------------------------------------------------------------
// The render (org/settings/applications.tmpl over the SHARED
// user/settings/applications_oauth2_list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). `error` carries the failed create's message (null
 *  otherwise). */
export function renderOrgApplicationsPage(options: {
  ctx: UiContext;
  data: OrgSettingsApplicationsData;
  error: string | null;
}): string {
  return renderPage(<OrgApplicationsPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/**
 * The org applications page (§2.4.1 discriminator: `organization settings
 * options` — org/settings/applications.tmpl:1's literal dict: the upstream
 * template passes the OPTIONS page's pageClass, not an applications one;
 * the quirk is kept verbatim, the hooks page's Settings-h4 precedent).
 * OrgHeader, the settings navbar with the applications item active, then
 * `.org-setting-content` wrapping the h4 + the shared list template's
 * segment + the create segment.
 */
export function OrgApplicationsPage(props: { ctx: UiContext; data: OrgSettingsApplicationsData; error: string | null }) {
  const { ctx, data } = props;
  const org = data.org;
  const orgLink = `/${org.username}`;
  const pageLink = `${orgLink}/settings/applications`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsApplicationsLocale.applications} pageClass="organization settings options">
      <OrgHeader org={org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="applications" />
        <div class="flex-container-main">
          {/* org/settings/applications.tmpl's .org-setting-content. */}
          <div class="org-setting-content">
            {/* applications.tmpl:3-5 — the h4. */}
            <h4 class="ui top attached header">{orgSettingsApplicationsLocale.applications}</h4>
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            {/* applications_oauth2_list.tmpl:1-48 — the attached segment:
                the description line, the rows, else the empty arm. */}
            <div class="ui attached segment">
              <div class="flex-divided-list items-with-main">
                <div class="item">{orgSettingsApplicationsLocale.create_description}</div>
                {data.apps.length === 0 ? (
                  <div class="item">{orgSettingsApplicationsLocale.no_apps}</div>
                ) : (
                  data.apps.map((app) => {
                    // toApiOAuth2Application is the render's client-id
                    // projection (the JSON.parse of the redirect_uris TEXT —
                    // the service's contract; the secret arg is the list's
                    // "" blank, app.go's hide-on-list arm).
                    const view = toApiOAuth2Application(app, "");
                    return (
                      <div class="item tw-items-center" key={app.id}>
                        <div class="item-leading">
                          {/* {{svg "octicon-apps" 32}} — outside the
                              allowlist; octicon-package is the documented
                              stand-in (the module header). */}
                          <Icon name={APP_ICON} size={32} />
                        </div>
                        <div class="item-main">
                          <div class="item-title">{view.name}</div>
                          <div class="item-body">
                            {orgSettingsApplicationsLocale.client_id}
                            <span class="ui label"> {view.client_id}</span>
                          </div>
                        </div>
                        <div class="item-trailing">
                          {/* applications_oauth2_list.tmpl:23-26 — the Edit
                              link rides the W5 shared edit page (the module
                              header's W5 record; the former dead-link
                              omission retired). The BuiltinApplications
                              "locked" arm is unreachable (org rows are
                              uid=org.id, builtins uid=0). The Remove button
                              rides the shared delete — the plain-form POST
                              (the confirm-dialog reduction; the desc text is
                              the aria label). */}
                          <a href={`${pageLink}/oauth2/${app.id}`} class="ui primary tiny button">
                            <Icon name="octicon-pencil" />
                            {` ${orgSettingsApplicationsLocale.edit}`}
                          </a>
                          <form method="post" action={`${pageLink}/oauth2/${app.id}/delete`} class="tw-inline">
                            <input type="hidden" name="id" value={String(app.id)} />
                            <button
                              type="submit"
                              class="ui red tiny button link-action negative"
                              aria-label={orgSettingsApplicationsLocale.remove_confirm}
                            >
                              <Icon name="octicon-trash" />
                              {` ${orgSettingsApplicationsLocale.remove}`}
                            </button>
                          </form>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            {/* applications_oauth2_list.tmpl:50-79 — the create segment: the
                details stays CLOSED when apps exist, OPEN on the empty/
                after-error arms (the template's
                `{{if .application_name}}open{{end}}` shape — the admin
                page's reduction note). */}
            <div class="ui bottom attached segment">
              <details open={props.error !== null || data.apps.length === 0 ? true : undefined}>
                <summary>
                  <h4 class="ui header tw-inline-block tw-my-2">{orgSettingsApplicationsLocale.create_oauth2_application}</h4>
                </summary>
                <form class="ui form ignore-dirty" action={`${pageLink}/oauth2`} method="post">
                  <div class="field">
                    <label for="application-name">{orgSettingsApplicationsLocale.application_name}</label>
                    <input id="application-name" name="application_name" value={data.form.name} required maxlength={255} />
                  </div>
                  <div class="field">
                    <label for="redirect-uris">{orgSettingsApplicationsLocale.redirect_uris}</label>
                    <textarea name="redirect_uris" id="redirect-uris">
                      {data.form.redirectUrisRaw}
                    </textarea>
                  </div>
                  <div class="field">
                    <div class="ui checkbox">
                      <label>{orgSettingsApplicationsLocale.confidential_client}</label>
                      <input type="checkbox" name="confidential_client" checked={data.form.confidentialClient ? true : undefined} />
                    </div>
                  </div>
                  <div class="field">
                    <div class="ui checkbox">
                      <label>{orgSettingsApplicationsLocale.skip_secondary_authorization}</label>
                      <input
                        type="checkbox"
                        name="skip_secondary_authorization"
                        checked={data.form.skipSecondaryAuthorization ? true : undefined}
                      />
                    </div>
                  </div>
                  <button type="submit" class="ui primary button">
                    {orgSettingsApplicationsLocale.create_oauth2_application_button}
                  </button>
                </form>
              </details>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
