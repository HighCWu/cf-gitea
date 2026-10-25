/**
 * The new-organization page, `/org/create` — pages wave 19 (SPEC-0008 U3
 * extension, the authoring front door's org half: the parity survey's #2).
 * Upstream `org.Create` / `org.CreatePost` (routers/web/org/org.go:30-77)
 * over templates/org/create.tmpl at the pin, posting through the landed
 * `POST /orgs` service (`OrgService.createOrg` — the creator receives the
 * role='owner' membership in the same batch, SPEC-0007 §2.1).
 *
 * ## DOM contract (templates/org/create.tmpl at the pin)
 *
 * `.page-content.organization.new.org` (BaseLayout's page-content div), one
 * `.ui.container.medium-width` holding the `.ui.top.attached.header`
 * ("new_org") + the `.ui.attached.segment` with the upstream
 * `<form class="ui form left-right-form" action="{.Link}" method="post">`:
 * the required `org_name` input (maxlength 40 — the CreateOrgForm binding
 * and the service's OrgNameTooLongError cap), the visibility radio group,
 * the `repo_admin_change_team_access` checkbox (the permission box) and the
 * primary submit ("org.create_org").
 *
 * ## Documented v1 divergences / degradations (§6)
 *
 * - The form carries `full_name` (display) and `email` fields the upstream
 *   template does not render (the brief's field set; both are landed
 *   `CreateOrgInput` columns upstream's API CreateOrgOption carries —
 *   modules/structs/org.go).
 * - The visibility radios post the landed enum strings
 *   (`public`/`limited`/`private`); upstream's radios post VisibleType
 *   integers 0/1/2 (org.go CreatePost builds the Organization straight from
 *   the bound form). Default public — upstream GET's
 *   `DefaultOrgVisibilityMode` default.
 * - The permission checkbox defaults CHECKED (upstream GET's
 *   `repo_admin_change_team_access = true`).
 * - Success 303s onto `/{org}` — OUR org home (the single-segment owner
 *   family). Upstream redirects onto `DashboardLink()` (`/org/{name}`
 *   dashboard, web/org/org.go:77) — a surface this UI does not carry.
 * - The `CanCreateOrganization` site-config gate is not rendered (the API
 *   route header's posture: the gate is unreachable at the landed tier —
 *   no DISABLED surface exists), so every signed-in viewer may create.
 * - Error texts: the taken name renders upstream's web message
 *   ("form.org_name_been_taken"); the reserved name renders upstream's web
 *   message with the offending value interpolated; the pattern, too-long and
 *   invalid-char cases render the landed service messages verbatim (the
 *   pattern error carries no interpolable value and the other two have no
 *   upstream web arm — the binding rejects MaxSize(40) client-side and
 *   ErrNameCharsNotAllowed is unhandled upstream).
 */

import { OrgError, OrgNameCollisionError, OrgNamePatternNotAllowedError, OrgNameReservedError } from "../../services/orgs/errors";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (component-local, the newIssueLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const orgCreateLocale = {
  title: "New Organization", // "new_org"
  org_name: "Organization Name", // "org.org_name_holder"
  org_name_helper: "Organization names should be short and memorable.", // "org.org_name_helper"
  full_name: "Full Name", // "org.settings.full_name" (the brief's display field)
  email: "Contact Email Address", // "org.settings.email" (the brief's email field)
  visibility: "Visibility", // "org.settings.visibility"
  visibility_public: "Public", // "org.settings.visibility.public"
  visibility_limited: "Limited (Visible to authenticated users only)", // "org.settings.visibility.limited"
  visibility_private: "Private (Visible only to organization members)", // "org.settings.visibility.private"
  permission: "Permissions", // "org.settings.permission"
  repoadminchangeteam: "Repository admin can add and remove access for teams", // "org.settings.repoadminchangeteam"
  create_org: "Create Organization", // "org.create_org"
  /** The empty-name re-render — cf-gitea addition (the new-issue
   *  title_required precedent; upstream's HTML5 `required` catches the
   *  browser case). */
  name_required: "An organization name is required.",
  /** The taken-name re-render — upstream's web message
   *  ("form.org_name_been_taken"). */
  name_taken: "The organization name is already taken.",
} as const;

/** The org visibility values the radios post (the landed `Visibility` enum —
 *  the upstream radio integers' stand-in, module header). */
export const ORG_CREATE_VISIBILITIES = ["public", "limited", "private"] as const;
export type OrgCreateVisibility = (typeof ORG_CREATE_VISIBILITIES)[number];

// ---------------------------------------------------------------------------
// Form parsing + the write (§3.2 — OrgService.createOrg directly)
// ---------------------------------------------------------------------------

/** The parsed `application/x-www-form-urlencoded` submission. An unknown or
 *  missing visibility degrades to public (upstream GET's
 *  DefaultOrgVisibilityMode default; the radios only emit known values). */
export interface OrgCreateForm {
  name: string;
  fullName: string;
  email: string;
  visibility: OrgCreateVisibility;
  repoAdminChangeTeamAccess: boolean;
}

/** Parse the POST body (the parseNewIssueForm conventions: trim the name,
 *  the checkbox is a field-present rule). */
export function parseOrgCreateForm(params: URLSearchParams): OrgCreateForm {
  const visibilityRaw = (params.get("visibility") ?? "").trim();
  const visibility = (ORG_CREATE_VISIBILITIES as readonly string[]).includes(visibilityRaw)
    ? (visibilityRaw as OrgCreateVisibility)
    : "public";
  return {
    name: (params.get("org_name") ?? "").trim(),
    fullName: (params.get("full_name") ?? "").trim(),
    email: (params.get("email") ?? "").trim(),
    visibility,
    repoAdminChangeTeamAccess: (params.get("repo_admin_change_team_access") ?? "") !== "",
  };
}

export type OrgCreateResult =
  | { outcome: "created"; org: OrgRecord }
  | { outcome: "invalid"; message: string };

/**
 * The write: the landed `POST /orgs` service (`OrgService.createOrg`) with
 * the session viewer as creator. The typed OrgError family re-renders inline
 * (module header's text table); nothing else escapes — the createOrg batch
 * is all-or-nothing, so there is no partial-write arm.
 */
export async function createOrgFromForm(
  d1: D1Database,
  viewer: Extract<Viewer, { kind: "user" }>,
  form: OrgCreateForm,
): Promise<OrgCreateResult> {
  if (form.name === "") return { outcome: "invalid", message: orgCreateLocale.name_required };
  try {
    const org = await new OrgService(d1).createOrg({
      name: form.name,
      ownerId: viewer.id,
      visibility: form.visibility,
      fullName: form.fullName === "" ? null : form.fullName,
      email: form.email === "" ? null : form.email,
      repoAdminChangeTeamAccess: form.repoAdminChangeTeamAccess,
    });
    return { outcome: "created", org };
  } catch (error) {
    if (error instanceof OrgNameCollisionError) {
      return { outcome: "invalid", message: orgCreateLocale.name_taken };
    }
    if (error instanceof OrgNameReservedError) {
      // Upstream's web message ("org.form.name_reserved") with the offending
      // value interpolated — the reserved list itself lives in the service.
      return { outcome: "invalid", message: `The organization name "${form.name}" is reserved.` };
    }
    if (error instanceof OrgNamePatternNotAllowedError) {
      // The service's message renders verbatim — upstream's web arm
      // interpolates Go's err.Pattern, which the ported error does not carry
      // (the API-contract text is the documented stand-in).
      return { outcome: "invalid", message: error.message };
    }
    if (error instanceof OrgError) {
      // The too-long / invalid-char services errors — no upstream web arm
      // exists (module header); the landed messages render verbatim.
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderOrgCreatePage(options: {
  ctx: UiContext;
  form: OrgCreateForm;
  error: string | null;
}): string {
  return renderPage(<OrgCreatePage ctx={options.ctx} form={options.form} error={options.error} />);
}

/** The new-organization page (§2.4.1 discriminator: `organization new org`). */
export function OrgCreatePage(props: { ctx: UiContext; form: OrgCreateForm; error: string | null }) {
  const { ctx, form } = props;
  return (
    <BaseLayout ctx={ctx} title={orgCreateLocale.title} pageClass="organization new org">
      <div class="ui container medium-width">
        <h3 class="ui top attached header">{orgCreateLocale.title}</h3>
        <div class="ui attached segment">
          <form class="ui form left-right-form" action="/org/create" method="post">
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            <div class="inline required field">
              <label for="org_name">{orgCreateLocale.org_name}</label>
              <input
                id="org_name"
                name="org_name"
                value={form.name}
                required
                maxlength={40}
                autocomplete="off"
                autofocus
              />
              <span class="help">{orgCreateLocale.org_name_helper}</span>
            </div>
            <div class="inline field">
              <label for="full_name">{orgCreateLocale.full_name}</label>
              <input id="full_name" name="full_name" value={form.fullName} maxlength={100} autocomplete="off" />
            </div>
            <div class="inline field">
              <label for="email">{orgCreateLocale.email}</label>
              <input id="email" name="email" type="email" value={form.email} maxlength={254} autocomplete="off" />
            </div>
            <div class="inline required field">
              <label for="visibility">{orgCreateLocale.visibility}</label>
              <div class="inline-right">
                {(
                  [
                    ["public", orgCreateLocale.visibility_public],
                    ["limited", orgCreateLocale.visibility_limited],
                    ["private", orgCreateLocale.visibility_private],
                  ] as Array<[OrgCreateVisibility, string]>
                ).map(([value, label]) => {
                  const radioId = `org-visibility-${value}`;
                  return (
                    <div class="ui radio checkbox">
                      <input id={radioId} name="visibility" type="radio" value={value} checked={form.visibility === value} />
                      <label for={radioId}>{label}</label>
                    </div>
                  );
                })}
              </div>
            </div>
            <div class="inline field">
              <label>{orgCreateLocale.permission}</label>
              <div class="ui checkbox">
                <input
                  id="repo_admin_change_team_access"
                  name="repo_admin_change_team_access"
                  type="checkbox"
                  checked={form.repoAdminChangeTeamAccess}
                />
                <label for="repo_admin_change_team_access">{orgCreateLocale.repoadminchangeteam}</label>
              </div>
            </div>
            <div class="inline field">
              <label></label>
              <button type="submit" class="ui primary button">
                {orgCreateLocale.create_org}
              </button>
            </div>
          </form>
        </div>
      </div>
    </BaseLayout>
  );
}
