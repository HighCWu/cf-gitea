/**
 * The org settings ACTIONS tab's SECRETS + VARIABLES sub-tabs — pages wave 59
 * (bench row `wave-org-actions-module`, MOUNTED at 4f2805f, window-2b — the
 * routes live in `index.ts`; the retired wiring HANDOFF is the mount record
 * below).
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 * `gitea/templates/org/settings/actions.tmpl` EXISTS and is the PageType
 * switchyard — runners / secrets / variables / scoped-workflows
 * (actions.tmpl:3-11) under the literal pageClass `organization settings
 * actions` (actions.tmpl:1). This module claims the secrets and variables
 * arms; the runners, general and scoped-workflows arms have no landed pages
 * (the dead-link rule — they render nothing in the navbar either).
 *
 *   - secrets arm: `shared/secrets/add_list.tmpl` fed by the ORG arm of
 *     `getSecretsCtx` (routers/web/repo/setting/secrets.go:49-61 —
 *     `BelongingScopeOwner(ctx.ContextUser.ID)`, RedirectLink
 *     `{OrgLink}/settings/actions/secrets`, tplOrgSecrets
 *     "org/settings/actions") through `Secrets` / `SecretsPost` /
 *     `SecretsDelete` (secrets.go:76-126) over `shared.PerformSecretsPost` /
 *     `PerformSecretsDelete` (routers/web/shared/secrets/secrets.go:35-56,
 *     58-71 — the WEB write path's EOL normalization at :42 is scope-shared,
 *     so the org arm normalizes too);
 *   - variables arm: `shared/variables/variable_list.tmpl` fed by the ORG arm
 *     of `getVariablesCtx` (routers/web/shared/actions/variables.go:49-60 —
 *     `BelongingScopeOwner(ctx.Org.Organization.ID)`, RedirectLink
 *     `{OrgLink}/settings/actions/variables`) through `Variables` /
 *     `VariableCreate` / `VariableUpdate` / `VariableDelete`
 *     (variables.go:83-200).
 *
 * Mounting upstream: web.go:498-503's `addSettingsSecretsRoutes` and
 * web.go:489-497's `addSettingsVariablesRoutes` inside web.go:1054-1062's
 * `/{org}/settings` `/actions` group (require-owner, behind
 * `actions.MustEnableActions`; `GET /settings/actions` is upstream's
 * LocationRedirect onto ./actions/general).
 *
 * ## Mount record (MOUNTED at 4f2805f — the wiring HANDOFF is retired)
 *
 * The org-settings posture everywhere (org-settings.tsx / org-settings-hooks
 * headers): `resolveOrgForRequest` (api/services/orgs.ts — the 404/307
 * rename-redirect arms, org-members.tsx:216-227's composition) then the
 * requireOrgOwnership posture (org owner `role='owner'` or site admin —
 * `OrgService.isOrgOwner`, services/orgs/orgs.ts:683): anonymous 303s onto
 * the login round-trip, a signed-in non-owner 404-shells (upstream's
 * RequireOwner OrgAssignment NotFound, web.go:1032's settings subtree).
 * Seven routes:
 *
 *   GET  /{org}/settings/actions/secrets → the ownership gate →
 *            loadOrgActionsSecretsPageData → renderOrgActionsSecretsPage.
 *   POST /{org}/settings/actions/secrets → the sameOriginGuard + the
 *            ownership gate, `readUrlEncodedForm`,
 *            `parseOrgActionsSecretForm`, then `applyOrgActionsSecretForm`
 *            (upstream SecretsPost → PerformSecretsPost). `outcome: "saved"`
 *            303s back onto the list URL (upstream's JSONRedirect — the
 *            `secrets.save_success` line does not render, the no-session-flash
 *            reduction, the landed user-scope secrets twin's convention). An
 *            `outcome: "invalid"` re-renders the page with the `error` line +
 *            the submitted `form` values (upstream's JSONErrorAuto is a
 *            form-fetch-action JS arm — the no-JS reduction re-renders).
 *   POST /{org}/settings/actions/secrets/delete →
 *            `parseOrgActionsSecretDeleteForm` + `deleteOrgActionsSecret` —
 *            both outcomes 303 back (a null/foreign/stale id answers
 *            "missing" and deletes nothing; the idempotent-303 reduction).
 *   GET  /{org}/settings/actions/variables →
 *            loadOrgActionsVariablesPageData → renderOrgActionsVariablesPage.
 *   POST /{org}/settings/actions/variables/new → `parseOrgActionsVariableForm`
 *            + `applyOrgActionsVariableCreate` (upstream VariableCreate);
 *            "saved" 303s back, "invalid" re-renders with the error line +
 *            the submitted add-form values, a non-ApiError (the UNIQUE
 *            duplicate-name db error — upstream has no web pre-check either)
 *            propagates to the generic error handler.
 *   POST /{org}/settings/actions/variables/{id}/edit → the path id through
 *            `parseOrgActionsVariablePathId`, then
 *            `applyOrgActionsVariableUpdate` (upstream VariableUpdate).
 *            "saved" 303s back; "invalid" re-renders; "missing" is upstream's
 *            `findActionsVariable` arm — a genuine ctx.NotFound(nil)
 *            (variables.go:172-175): answer the app's 404 shell.
 *   POST /{org}/settings/actions/variables/{id}/delete → the path id +
 *            `deleteOrgActionsVariable` (upstream VariableDelete).
 *            "deleted" 303s back; "missing" is the same NotFound arm
 *            (variables.go:186-191).
 *
 * `GET /{org}/settings/actions` itself is upstream's LocationRedirect onto
 * ./actions/general (web.go:1055) — the general tab is NOT this module's
 * claim (no landed page); the dispatcher 404-shells it until that slice
 * lands. `/{org}` in every URL is the LIVE org name (orgLink =
 * `/${org.username}` — a renamed org's next GET renders the new link set).
 *
 * ## Data (§3.2 — the LANDED 0021 store + the secrets-variables service)
 *
 * THE ORG OPS HAVE LANDED — no documented-unrendered arm. The service is
 * scope-generic: `ownerScope(org.id)` IS the org arm (upstream
 * BelongingScopeOwner's own encoding, models/secret/secret.go:25-33 — org and
 * user owner-scope rows share `{ownerId, repoId: ''}`; orgs are users-table
 * rows, so the id spaces are disjoint and cannot collide). Every op this page
 * needs exists and is already served live by the landed org-scope API family
 * (api/routes/secrets-variables.ts:610-870 — `/orgs/{org}/actions/secrets*`
 * and `.../variables*` all through `ownerScope(org.id)`):
 *
 *   secrets   list `listSecretRows` / write `createOrUpdateSecret` (the
 *             PUT-arm upsert) / delete `deleteSecretByName`;
 *   variables list `listVariableRows` / create `createVariableRow` / update
 *             `updateVariableRow` / delete `deleteVariableRow`.
 *
 * As in the user-scope twins: upstream's web list is UNPAGINATED (`db.Find`,
 * shared/secrets/secrets.go:25-28, shared/actions/variables.go:94-96) while
 * the landed service paginates, so the loaders pass a beyond-any-store limit
 * (the *_WEB_LIST_LIMIT constants) — the documented seam. The web routes are
 * ID-keyed while the landed delete/update are NAME-keyed (the API's path-name
 * shape), so the module does the id→row hop inside the org's scope first — a
 * foreign or stale id answers "missing". The secrets write path applies the
 * EOL normalization module-side (PerformSecretsPost, shared/secrets/
 * secrets.go:42); the variable ops normalize inside the service
 * (InsertVariable / UpdateVariableNameData), so no module-level twin rides
 * there. Validation failures surface the service's exact ApiError texts (the
 * ValidateName trio + "data too long") as the re-rendered error line.
 *
 * ## DOM contract (org/settings/{layout_head,navbar,actions}.tmpl +
 *  shared/secrets/add_list.tmpl + shared/variables/variable_list.tmpl)
 *
 * layout_head's pageClass is the literal `organization settings actions` for
 * BOTH sub-tabs (actions.tmpl:1). The page is OrgHeader (the shared
 * org/header.tmpl) over the flex-container pair: org/settings/navbar.tmpl's
 * `.flex-container-nav` menu with the Actions disclosure OPEN and the active
 * sub-item (navbar.tmpl:29-47 — open when any of the five PageIs*Actions
 * flags is set; Secrets :38-40, Variables :41-43), then
 * `.org-setting-content` (actions.tmpl:2) with the `h4.ui.top.attached.header`
 * over the `.ui.attached.segment`: the `.flex-divided-list.items-with-main`
 * rows or the none-line, then the add form — field names exactly the shared
 * dialogs' (`name` pattern `^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$`
 * (add_list.tmpl:81, variable_list.tmpl:79), `data` maxlength
 * DataMaxLength, `description` maxlength 4096 rows 2). The secrets row masks
 * the body with `******`; the variables row renders the value IN PLAINTEXT
 * (variable_list.tmpl:31-33).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The `#add-secret-modal` / `#edit-variable-modal` dialogs + `show-modal`
 *   buttons are upstream's JS modal pairs — reduced to the landed user-scope
 *   twins' no-JS shape: the ADD form renders inline in the segment; each
 *   secrets row's EDIT renders as a `<details>` disclosure with the READ-ONLY
 *   name and an EMPTY value textarea (the plaintext never enters the DOM,
 *   add_list.tmpl:46-47); each variables row's EDIT disclosure pre-fills all
 *   three fields (the one-dialog shape, variable_list.tmpl:44-46) and posts
 *   to the row's own `/{id}/edit` URL.
 * - The secrets add form posts to the LIST URL (upstream
 *   `data-modal-form.url {{.Link}}`); the variables add form posts to
 *   `.../variables/new` (variable_list.tmpl:6).
 * - The remove buttons are plain form POSTs (upstream's `link-action` +
 *   `data-modal-confirm` pairs are not reproduced): secrets to
 *   `.../secrets/delete` with the hidden row id; variables to the row's
 *   `/{id}/delete` URL with the id in the path, labeled with the deletion
 *   tooltip's text ("Remove variable") over octicon-trash.
 * - The navbar is the SHARED components/settings-nav OrgSettingsNavbar (the
 *   wave-114 swap — this module's mount-scaffolding OrgSettingsActionsNav
 *   copy is deleted) rendered with `active: "secrets"` / `"variables"`; the
 *   Actions disclosure opens while either page renders, and the General /
 *   Runners / Scoped-workflows sub-items render nothing (no landed pages —
 *   the dead-link rule; the shared module's header).
 * - The row date renders upstream's `DateUtils.AbsoluteShort` ("Jan 2, 2006")
 *   in UTC (the hand-rolled-clock precedent, the twins' formatSecretDate).
 * - `GET /settings/actions`' general tab (upstream's runners-general +
 *   unit settings) is unlanded — not rendered, not linked.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  createOrUpdateSecret,
  createVariableRow,
  deleteSecretByName,
  deleteVariableRow,
  listSecretRows,
  listVariableRows,
  ownerScope,
  SECRET_DATA_MAX_BYTES,
  updateVariableRow,
  VARIABLE_DATA_MAX_RUNES,
  type SecretRow,
  type VariableRow,
} from "../../api/services/secrets-variables";
import { actionVariables, secrets } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { IconName } from "../icons";
import type { UiContext } from "../ui-context";
import { OrgSettingsNavbar } from "../components/settings-nav";
import { OrgHeader } from "./org-home";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const orgSettingsActionsLocale = {
  actions: "Actions", // "actions.actions" (the secrets page Title, secrets.go:77; the shared navbar carries the disclosure)
  variables: "Variables", // "actions.variables" (the variables page Title, variables.go:84; the shared navbar carries the sub-item)
  secrets_management: "Secrets Management", // "secrets.management"
  variables_management: "Variables Management", // "actions.variables.management"
  add_secret: "Add Secret", // "secrets.add_secret"
  edit_secret: "Edit secret", // "secrets.edit_secret"
  add_variable: "Add Variable", // "actions.variables.creation"
  edit_variable: "Edit Variable", // "actions.variables.edit"
  secrets_description: "Secrets will be passed to certain actions and cannot be read otherwise.", // "secrets.description" (the dialog's lead line)
  variables_description: "Variables will be passed to certain actions and cannot be read otherwise.", // "actions.variables.description" (the dialog's lead line)
  name: "Name", // "name"
  value: "Value", // "value"
  description_label: "Description", // "secrets.creation.description"
  name_pattern:
    "Name must start with a letter or underscore, contain only letters, numbers, and underscores, and must not start with GITEA_ or GITHUB_", // "secrets.creation.name_pattern" (both dialogs' tooltip)
  value_placeholder: "Input any content. Whitespace at the start and end will be omitted.", // "secrets.creation.value_placeholder"
  description_placeholder: "Enter short description (optional).", // "secrets.creation.description_placeholder"
  secrets_none: "There are no secrets yet.", // "secrets.none"
  variables_none: "There are no variables yet.", // "actions.variables.none"
  added_on: "Added on", // "settings.added_on %s" — the date renders beside it
  remove: "Remove", // "remove" (the secrets delete button — the user-scope twin's label)
  deletion: "Remove variable", // "actions.variables.deletion" (the variables delete button's tooltip → its label)
  // The validation texts the apply functions answer (the service's exact
  // ApiError messages — the module header).
  invalid_name_pattern: "name must start with a letter or underscore and contain only letters, numbers, and underscores", // services/secrets-variables.ts:106
  invalid_name_prefix: "name cannot start with 'GITEA_' or 'GITHUB_'", // services/secrets-variables.ts:110
  reserved_ci: "'CI' is a reserved name", // services/secrets-variables.ts:113
  data_too_long: "data too long", // services/secrets-variables.ts:174
} as const;

/** The dialogs' `name` input pattern attribute, verbatim (add_list.tmpl:81,
 *  variable_list.tmpl:79) — the client-side mirror of ValidateName. */
export const ORG_ACTIONS_NAME_PATTERN = "^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$";

/** The secrets `data` textarea's maxlength (SecretDataMaxLength —
 *  add_list.tmpl:91's {{.DataMaxLength}}). */
export const ORG_ACTIONS_SECRET_DATA_MAXLENGTH = SECRET_DATA_MAX_BYTES;

/** The variables `data` textarea's maxlength (VariableDataMaxLength —
 *  variable_list.tmpl:89; RUNES upstream, the HTML attribute counts UTF-16
 *  units — the user-scope twin's documented reduction). */
export const ORG_ACTIONS_VARIABLE_DATA_MAXLENGTH = VARIABLE_DATA_MAX_RUNES;

/** The `description` textareas' maxlength (SecretDescriptionMaxLength /
 *  VariableDescriptionMaxLength — add_list.tmpl:101, variable_list.tmpl:99). */
export const ORG_ACTIONS_DESCRIPTION_MAXLENGTH = 4096;

/** The loaders' list caps — upstream's web lists are unpaginated (`db.Find`)
 *  while the landed service paginates; a beyond-any-store page size answers
 *  the same rows (the module header; the twins' *_WEB_LIST_LIMIT seam). */
export const ORG_ACTIONS_WEB_LIST_LIMIT = 10000;

// ---------------------------------------------------------------------------
// The secrets write arms (upstream SecretsPost/SecretsDelete over the landed
// service at the ORG owner scope)
// ---------------------------------------------------------------------------

/** The secrets POST body (the upstream dialog's three fields). */
export interface OrgActionsSecretForm {
  name: string;
  data: string;
  description: string;
}

/** Parse the urlencoded secrets POST (the readUrlEncodedForm convention). */
export function parseOrgActionsSecretForm(params: URLSearchParams): OrgActionsSecretForm {
  return {
    name: params.get("name") ?? "",
    data: params.get("data") ?? "",
    description: params.get("description") ?? "",
  };
}

/** The save outcomes the POST handler renders (the twins' outcome pattern). */
export type SaveOrgActionsSecretOutcome = { outcome: "saved" } | { outcome: "invalid"; message: string };

/** util.NormalizeStringEOL (modules/util/util.go:312) — the WEB write path's
 *  normalization (shared/secrets/secrets.go:42, scope-shared so the org arm
 *  normalizes too); the landed service mirrors the API path, which does not
 *  normalize, so the module applies it (the user-scope twin's shape). */
function normalizeStringEol(input: string): string {
  return input.replaceAll("\r\n", "\n");
}

/**
 * The save — upstream SecretsPost → PerformSecretsPost
 * (shared/secrets/secrets.go:35-56) over the landed `createOrUpdateSecret`
 * at `ownerScope(org.id)`: the service validates the name (the ValidateName
 * trio) and length-caps the data, upserting by UPPER(name) — create on a
 * miss, data+description update on a hit (the dialog's edit posts the
 * read-only name back through the same URL). A service ApiError becomes the
 * `invalid` outcome with the exact text; anything else propagates.
 */
export async function applyOrgActionsSecretForm(d1: D1Database, orgId: number, form: OrgActionsSecretForm): Promise<SaveOrgActionsSecretOutcome> {
  try {
    await createOrUpdateSecret(d1, ownerScope(orgId), form.name, normalizeStringEol(form.data), form.description);
  } catch (error) {
    if (error instanceof ApiError) {
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
  return { outcome: "saved" };
}

/** The secrets/delete POST body (upstream's `id` — PerformSecretsDelete's
 *  FormInt64, shared/secrets/secrets.go:60). */
export interface OrgActionsSecretDeleteForm {
  id: number | null;
}

export function parseOrgActionsSecretDeleteForm(params: URLSearchParams): OrgActionsSecretDeleteForm {
  const raw = params.get("id") ?? "";
  return { id: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null };
}

/**
 * The delete — upstream SecretsDelete → PerformSecretsDelete
 * (shared/secrets/secrets.go:58-71): resolve the row within the ORG's scope
 * (upstream's DeleteSecretByID is scope-guarded the same way), then the
 * landed name-keyed `deleteSecretByName`. `"missing"` covers a null id, a
 * foreign id (another owner's — user or org; the id spaces are disjoint) and
 * a stale id — every arm 303s back (the idempotent-303 reduction).
 */
export async function deleteOrgActionsSecret(d1: D1Database, orgId: number, form: OrgActionsSecretDeleteForm): Promise<"deleted" | "missing"> {
  if (form.id === null) {
    return "missing";
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, form.id), eq(secrets.ownerId, orgId), eq(secrets.repoId, "")))
      .limit(1)
  )[0];
  if (row === undefined) {
    return "missing";
  }
  const deleted = await deleteSecretByName(d1, ownerScope(orgId), row.name);
  return deleted === null ? "missing" : "deleted";
}

// ---------------------------------------------------------------------------
// The variables write arms (upstream VariableCreate/VariableUpdate/
// VariableDelete over the landed service at the ORG owner scope)
// ---------------------------------------------------------------------------

/** The variable POST body (the upstream dialog's three fields — the shared
 *  EditVariableForm, forms/user_form.go:235-240). */
export interface OrgActionsVariableForm {
  name: string;
  data: string;
  description: string;
}

/** Parse the urlencoded variable POST (the readUrlEncodedForm convention). */
export function parseOrgActionsVariableForm(params: URLSearchParams): OrgActionsVariableForm {
  return {
    name: params.get("name") ?? "",
    data: params.get("data") ?? "",
    description: params.get("description") ?? "",
  };
}

/** The `{variable_id}` path segment (upstream's PathParamInt64): digits only,
 *  junk/absent → null → the `"missing"` arm. */
export function parseOrgActionsVariablePathId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/** The outcomes the variable write handlers render (the user-scope variables
 *  twin's outcome pattern + upstream's findActionsVariable 404 arm). */
export type SaveOrgActionsVariableOutcome =
  | { outcome: "saved" }
  | { outcome: "invalid"; message: string }
  | { outcome: "missing" };

/**
 * The create — upstream VariableCreate → actions_service.CreateVariable
 * (variables.go:107-129) over the landed `createVariableRow` at
 * `ownerScope(org.id)`: the service validates the name, rune-counts the
 * value, truncates the description, EOL-normalizes and stores the UPPERCASE
 * name (all inside the service — no module-level normalization, unlike the
 * secrets arm). A service ApiError becomes `invalid` with the exact text;
 * anything else (the UNIQUE duplicate-name db error — upstream has no web
 * pre-check either) propagates.
 */
export async function applyOrgActionsVariableCreate(d1: D1Database, orgId: number, form: OrgActionsVariableForm): Promise<SaveOrgActionsVariableOutcome> {
  try {
    await createVariableRow(d1, ownerScope(orgId), form.name, form.data, form.description);
  } catch (error) {
    if (error instanceof ApiError) {
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
  return { outcome: "saved" };
}

/**
 * The update — upstream VariableUpdate (variables.go:131-161): resolve the
 * row by id within the ORG's scope (findActionsVariable's
 * FindVariablesOpts{IDs, BelongingScope} — a miss is the `"missing"`
 * outcome, upstream's ctx.NotFound(nil), variables.go:172-175), then the
 * landed `updateVariableRow` over the row's stored (UPPERCASE) name: the
 * form's name/data/description overwrite all three. An empty form name rides
 * the service's zero-value fallback (keeps the stored name). A service
 * ApiError becomes `invalid`; a resolve-to-update race is `"missing"` like
 * upstream's own re-find arm.
 */
export async function applyOrgActionsVariableUpdate(
  d1: D1Database,
  orgId: number,
  variableId: number | null,
  form: OrgActionsVariableForm,
): Promise<SaveOrgActionsVariableOutcome> {
  if (variableId === null) {
    return { outcome: "missing" };
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(actionVariables)
      .where(and(eq(actionVariables.id, variableId), eq(actionVariables.ownerId, orgId), eq(actionVariables.repoId, "")))
      .limit(1)
  )[0];
  if (row === undefined) {
    return { outcome: "missing" };
  }
  try {
    const updated = await updateVariableRow(d1, ownerScope(orgId), row.name, form.name, form.data, form.description);
    if (updated === null) {
      return { outcome: "missing" };
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
  return { outcome: "saved" };
}

/**
 * The delete — upstream VariableDelete (variables.go:179-200): resolve the
 * row within the ORG's scope (a foreign, stale or junk id answers
 * `"missing"`, upstream's ctx.NotFound(nil), variables.go:186-191), then the
 * landed name-keyed `deleteVariableRow` on the row's stored name.
 */
export async function deleteOrgActionsVariable(d1: D1Database, orgId: number, variableId: number | null): Promise<"deleted" | "missing"> {
  if (variableId === null) {
    return "missing";
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(actionVariables)
      .where(and(eq(actionVariables.id, variableId), eq(actionVariables.ownerId, orgId), eq(actionVariables.repoId, "")))
      .limit(1)
  )[0];
  if (row === undefined) {
    return "missing";
  }
  const deleted = await deleteVariableRow(d1, ownerScope(orgId), row.name);
  return deleted === null ? "missing" : "deleted";
}

// ---------------------------------------------------------------------------
// The list loaders (upstream SetSecretsContext / Variables' Find —
// shared/secrets/secrets.go:24-33, shared/actions/variables.go:94-96)
// ---------------------------------------------------------------------------

/** The secrets sub-tab's render inputs. `form` re-renders the submitted
 *  add/edit values (the empty triple on the plain GET). */
export interface OrgActionsSecretsPageData {
  org: OrgRecord;
  secrets: SecretRow[];
  form: OrgActionsSecretForm;
}

/** The secrets page load — the org's owner-scope rows, name-ordered (the
 *  service's FindSecretsOptions order). */
export async function loadOrgActionsSecretsPageData(d1: D1Database, org: OrgRecord): Promise<OrgActionsSecretsPageData> {
  const { rows } = await listSecretRows(d1, ownerScope(org.id), 1, ORG_ACTIONS_WEB_LIST_LIMIT);
  return { org, secrets: rows, form: { name: "", data: "", description: "" } };
}

/** The variables sub-tab's render inputs. `form` re-renders the submitted add
 *  values (the empty triple on the plain GET). */
export interface OrgActionsVariablesPageData {
  org: OrgRecord;
  variables: VariableRow[];
  form: OrgActionsVariableForm;
}

/** The variables page load — the org's owner-scope rows, name-ordered. */
export async function loadOrgActionsVariablesPageData(d1: D1Database, org: OrgRecord): Promise<OrgActionsVariablesPageData> {
  const { rows } = await listVariableRows(d1, ownerScope(org.id), 1, ORG_ACTIONS_WEB_LIST_LIMIT);
  return { org, variables: rows, form: { name: "", data: "", description: "" } };
}

// ---------------------------------------------------------------------------
// The render (org/settings/actions.tmpl PageType "secrets"/"variables" +
//  shared/secrets/add_list.tmpl + shared/variables/variable_list.tmpl)
// ---------------------------------------------------------------------------

/** Upstream `DateUtils.AbsoluteShort` ("Jan 2, 2006") — UTC, hand-rolled so
 *  the bytes never depend on the runtime's ICU (the twins'
 *  formatSecretDate/formatVariableDate precedent). */
export function formatActionsDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** The shared name/value/description fields (the upstream dialogs' three
 *  field divs, add_list.tmpl:73-104 / variable_list.tmpl:74-102).
 *  `readOnlyName` is the secrets EDIT arm's shape (read-only name, EMPTY
 *  value — the plaintext never enters the DOM); the variables dialog has no
 *  read-only arm (one dialog pre-fills all three). */
function ActionsFormFields(props: {
  idPrefix: string;
  form: { name: string; data: string; description: string };
  readOnlyName: boolean;
  dataMaxlength: number;
  /** The add arm's name placeholder — the dialogs' MY_SECRET_NAME
   *  (add_list.tmpl:83) / MY_VARIABLE_NAME (variable_list.tmpl:81); the
   *  read-only edit arm renders none. */
  namePlaceholder: string;
}) {
  return (
    <>
      <div class="field">
        <label for={`${props.idPrefix}-name`}>{orgSettingsActionsLocale.name}</label>
        <input
          autofocus={props.readOnlyName ? undefined : true}
          required
          id={`${props.idPrefix}-name`}
          name="name"
          value={props.form.name}
          pattern={props.readOnlyName ? undefined : ORG_ACTIONS_NAME_PATTERN}
          title={orgSettingsActionsLocale.name_pattern}
          placeholder={props.readOnlyName ? undefined : props.namePlaceholder}
          readOnly={props.readOnlyName ? true : undefined}
        />
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-data`}>{orgSettingsActionsLocale.value}</label>
        <textarea
          required
          id={`${props.idPrefix}-data`}
          name="data"
          maxlength={props.dataMaxlength}
          placeholder={orgSettingsActionsLocale.value_placeholder}
        >
          {props.readOnlyName ? "" : props.form.data}
        </textarea>
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-description`}>{orgSettingsActionsLocale.description_label}</label>
        <textarea
          id={`${props.idPrefix}-description`}
          name="description"
          rows={2}
          maxlength={ORG_ACTIONS_DESCRIPTION_MAXLENGTH}
          placeholder={orgSettingsActionsLocale.description_placeholder}
        >
          {props.readOnlyName ? "" : props.form.description}
        </textarea>
      </div>
    </>
  );
}

/** One add_list.tmpl row (add_list.tmpl:21-59) at the ORG URLs: the key
 *  glyph, the name/description/****** body, the Added-on stamp, the edit
 *  disclosure (the modal reduction — read-only name, empty value) and the
 *  remove form (the hidden-id POST to .../secrets/delete). */
export function OrgActionsSecretRowItem(props: { orgLink: string; row: SecretRow }) {
  const { row } = props;
  return (
    <div class="item tw-items-center">
      <div class="item-leading">
        <Icon name={SECRET_ICON} size={32} />
      </div>
      <div class="item-main">
        <div class="item-title">{row.name}</div>
        <div class="item-body">{row.description !== "" ? row.description : "-"}</div>
        <div class="item-body">******</div>
      </div>
      <div class="item-trailing">
        <span>
          {orgSettingsActionsLocale.added_on} {formatActionsDate(row.createdAt)}
        </span>
        <details>
          <summary class="flex-text-inline">
            <Icon name="octicon-pencil" /> {orgSettingsActionsLocale.edit_secret}
          </summary>
          {/* The modal's form (add_list.tmpl:71 — data-modal-form.url
              {{$.Link}}): the list URL, read-only name, empty value. */}
          <form class="ui form" action={`${props.orgLink}/settings/actions/secrets`} method="post">
            <ActionsFormFields
              idPrefix={`secret-edit-${row.id}`}
              form={{ name: row.name, data: "", description: "" }}
              readOnlyName={true}
              dataMaxlength={ORG_ACTIONS_SECRET_DATA_MAXLENGTH}
              namePlaceholder="MY_SECRET_NAME"
            />
            <div class="field">
              <button type="submit" class="ui primary button">
                {orgSettingsActionsLocale.edit_secret}
              </button>
            </div>
          </form>
        </details>
        <form class="tw-inline-block" action={`${props.orgLink}/settings/actions/secrets/delete`} method="post">
          <input type="hidden" name="id" value={String(row.id)} />
          <button type="submit" class="ui red tiny button">
            {orgSettingsActionsLocale.remove}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The row's leading glyph. Upstream renders `{{svg "octicon-key" 32}}`
 *  (add_list.tmpl:23); octicon-key is outside the generated icon allowlist —
 *  octicon-shield-lock is the documented stand-in (the keys sibling's
 *  KEY_ICON convention, the user-scope twin's SECRET_ICON). */
const SECRET_ICON: IconName = "octicon-shield-lock";

/** One variable_list.tmpl row (variable_list.tmpl:20-58) at the ORG URLs:
 *  the pencil glyph, the name/description/value body — the value renders IN
 *  PLAINTEXT (variable_list.tmpl:31-33; variables are not masked) — the
 *  Added-on stamp, the edit disclosure (all three fields pre-filled,
 *  variable_list.tmpl:44-46) posting to the row's own /{id}/edit URL, and
 *  the remove form (the id in the path, no hidden field). */
export function OrgActionsVariableRowItem(props: { orgLink: string; row: VariableRow }) {
  const { row } = props;
  return (
    <div class="item tw-items-center">
      <div class="item-leading">
        <Icon name="octicon-pencil" size={32} />
      </div>
      <div class="item-main">
        <div class="item-title">{row.name}</div>
        <div class="item-body">{row.description !== "" ? row.description : "-"}</div>
        <div class="item-body">{row.data}</div>
      </div>
      <div class="item-trailing">
        <span>
          {orgSettingsActionsLocale.added_on} {formatActionsDate(row.createdAt)}
        </span>
        <details>
          <summary class="flex-text-inline">
            <Icon name="octicon-pencil" /> {orgSettingsActionsLocale.edit_variable}
          </summary>
          {/* The dialog's form (variable_list.tmpl:69) targeting the row's
              own URL ({{$.Link}}/{{.ID}}/edit, :42), pre-filled from the row
              (:44-46). */}
          <form class="ui form" action={`${props.orgLink}/settings/actions/variables/${row.id}/edit`} method="post">
            <ActionsFormFields
              idPrefix={`variable-edit-${row.id}`}
              form={{ name: row.name, data: row.data, description: row.description }}
              readOnlyName={false}
              dataMaxlength={ORG_ACTIONS_VARIABLE_DATA_MAXLENGTH}
              namePlaceholder="MY_VARIABLE_NAME"
            />
            <div class="field">
              <button type="submit" class="ui primary button">
                {orgSettingsActionsLocale.edit_variable}
              </button>
            </div>
          </form>
        </details>
        <form class="tw-inline-block" action={`${props.orgLink}/settings/actions/variables/${row.id}/delete`} method="post">
          <button type="submit" class="ui red tiny button">
            <Icon name="octicon-trash" /> {orgSettingsActionsLocale.deletion}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The full-document renders (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component).
 *  `error` carries the failed POST's message (null on the plain GET). */
export function renderOrgActionsSecretsPage(ctx: UiContext, data: OrgActionsSecretsPageData, error: string | null = null): string {
  return renderPage(<OrgActionsSecretsPage ctx={ctx} data={data} error={error} />);
}

export function renderOrgActionsVariablesPage(ctx: UiContext, data: OrgActionsVariablesPageData, error: string | null = null): string {
  return renderPage(<OrgActionsVariablesPage ctx={ctx} data={data} error={error} />);
}

/** The secrets page (§2.4.1 discriminator: `organization settings actions` —
 *  layout_head's pageClass dict, actions.tmpl:1; upstream's Title is
 *  `actions.actions`, secrets.go:77). */
export function OrgActionsSecretsPage(props: { ctx: UiContext; data: OrgActionsSecretsPageData; error: string | null }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsActionsLocale.actions} pageClass="organization settings actions">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="secrets" />
        <div class="flex-container-main">
          <div class="org-setting-content">
            {/* shared/secrets/add_list.tmpl:1-16 */}
            <h4 class="ui top attached header">{orgSettingsActionsLocale.secrets_management}</h4>
            <div class="ui attached segment">
              {props.data.secrets.length > 0 ? (
                <div class="flex-divided-list items-with-main">
                  {props.data.secrets.map((row) => (
                    <OrgActionsSecretRowItem key={row.id} orgLink={orgLink} row={row} />
                  ))}
                </div>
              ) : (
                <p>{orgSettingsActionsLocale.secrets_none}</p>
              )}
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {/* The add-secret dialog reduced to the inline form (the
                  module header) — the dialog's lead line rides above it
                  (add_list.tmpl:74). */}
              <div class="tw-mt-4" id="add-secret-panel">
                <p>{orgSettingsActionsLocale.secrets_description}</p>
                <form class="ui form" action={`${orgLink}/settings/actions/secrets`} method="post">
                  <ActionsFormFields
                    idPrefix="secret-add"
                    form={props.data.form}
                    readOnlyName={false}
                    dataMaxlength={ORG_ACTIONS_SECRET_DATA_MAXLENGTH}
                    namePlaceholder="MY_SECRET_NAME"
                  />
                  <div class="field">
                    <button type="submit" class="ui primary button">
                      {orgSettingsActionsLocale.add_secret}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The variables page (§2.4.1 discriminator: `organization settings actions`
 *  — actions.tmpl:1; upstream's Title is `actions.variables`,
 *  variables.go:84). */
export function OrgActionsVariablesPage(props: { ctx: UiContext; data: OrgActionsVariablesPageData; error: string | null }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsActionsLocale.variables} pageClass="organization settings actions">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="variables" />
        <div class="flex-container-main">
          <div class="org-setting-content">
            {/* shared/variables/variable_list.tmpl:1-64 */}
            <h4 class="ui top attached header">{orgSettingsActionsLocale.variables_management}</h4>
            <div class="ui attached segment">
              {props.data.variables.length > 0 ? (
                <div class="flex-divided-list items-with-main">
                  {props.data.variables.map((row) => (
                    <OrgActionsVariableRowItem key={row.id} orgLink={orgLink} row={row} />
                  ))}
                </div>
              ) : (
                <p>{orgSettingsActionsLocale.variables_none}</p>
              )}
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {/* The #edit-variable-modal dialog reduced to the inline add
                  form (the module header) — the dialog's lead line rides
                  above it (variable_list.tmpl:72). */}
              <div class="tw-mt-4" id="add-variable-panel">
                <p>{orgSettingsActionsLocale.variables_description}</p>
                <form class="ui form" action={`${orgLink}/settings/actions/variables/new`} method="post">
                  <ActionsFormFields
                    idPrefix="variable-add"
                    form={props.data.form}
                    readOnlyName={false}
                    dataMaxlength={ORG_ACTIONS_VARIABLE_DATA_MAXLENGTH}
                    namePlaceholder="MY_VARIABLE_NAME"
                  />
                  <div class="field">
                    <button type="submit" class="ui primary button">
                      {orgSettingsActionsLocale.add_variable}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
