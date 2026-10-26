/**
 * The user settings ACTIONS VARIABLES tab, `/user/settings/actions/variables`
 * — pages wave 58 (bench row `wave-user-variables-module`, TWO-STAGE
 * UNMOUNTED — the route rides the index.ts window; `index.ts` is
 * orchestrator/sibling-owned).
 *
 * Upstream pin: the PageType "variables" arm of `user/settings/actions.tmpl`
 * (actions.tmpl:7-8, pageClass `user settings actions` from line 1) rendering
 * `shared/variables/variable_list.tmpl`, fed by the user arm of the shared
 * variables family — `shared_actions.Variables` / `VariableCreate` /
 * `VariableUpdate` / `VariableDelete` through `getVariablesCtx`'s
 * PageIsUserSettings arm (routers/web/shared/actions/variables.go:62-69 —
 * `BelongingScopeOwner(ctx.Doer.ID)`, RedirectLink
 * `/user/settings/actions/variables`), mounted by
 * `addSettingsVariablesRoutes` (web.go:489-497) at web.go:729 inside the
 * `/actions` group of the reqSignIn `/user/settings` group (behind
 * `actions.MustEnableActions`).
 *
 * ## HANDOFF NOTE (for the wiring wave)
 *
 * Upstream's route group is web.go:489-497 shared across the four scopes; the
 * user scope mounts inside web.go:707-731's `/actions` group. Four routes:
 *
 *   GET /user/settings/actions/variables → resolveUiSession (signed-in gate,
 *            the user-settings.tsx pattern) → loadUserSettingsVariablesPageData
 *            → renderUserSettingsVariablesPage; a session doer without a D1 row
 *            404-shells (the silent-auth-failure convention).
 *   POST /user/settings/actions/variables/new → the sameOriginGuard + the
 *            signed-in gate, `readUrlEncodedForm`, `parseUserSettingsVariableForm`,
 *            then `applyUserSettingsVariableCreate` (upstream VariableCreate →
 *            actions_service.CreateVariable, variables.go:107-129).
 *            `outcome: "saved"` 303s back onto
 *            `/user/settings/actions/variables` (upstream's JSONRedirect; the
 *            `actions.variables.creation.success` flash line does not render —
 *            the no-session-flash reduction, the secrets sibling's convention).
 *            An `outcome: "invalid"` re-renders the page with the `error` line
 *            + the submitted `form` values (upstream's JSONErrorAuto is a
 *            form-fetch-action JS arm — the no-JS reduction re-renders, the
 *            keys sibling's RenderWithErrDeprecated arm).
 *   POST /user/settings/actions/variables/{id}/edit → the same guards, the
 *            path id through `parseUserSettingsVariablePathId`, then
 *            `applyUserSettingsVariableUpdate` (upstream VariableUpdate:
 *            findActionsVariable → the form fields onto the row →
 *            UpdateVariableNameData, variables.go:131-161). `"saved"` 303s
 *            back (the update.success flash does not render); `"invalid"`
 *            re-renders with the error line + the submitted add-form values;
 *            `"missing"` is upstream's `findActionsVariable` arm — a genuine
 *            `ctx.NotFound(nil)` (variables.go:172-175), NOT the secrets
 *            sibling's flash-and-redirect delete: answer the app's 404 shell
 *            (upstream fidelity; the sibling's idempotent-303 reduction is
 *            available if the route wave prefers cross-sibling consistency).
 *   POST /user/settings/actions/variables/{id}/delete → the path id + `deleteUserSettingsVariable`
 *            (upstream VariableDelete: findActionsVariable → DeleteVariableByID,
 *            variables.go:179-200). `"deleted"` 303s back (the deletion.success
 *            flash does not render); `"missing"` is the same NotFound arm
 *            (variables.go:186-191).
 *
 * A non-numeric path id parses null → the `"missing"` arm (upstream's
 * PathParamInt64 junk → NotFound). The doer IS the owner — the scope is
 * `ownerScope(doer.id)` (services/secrets-variables.ts's BelongingScopeOwner
 * encoding), the same authorization shape as the landed user-scope API ops
 * (`/user/actions/variables/*`).
 *
 * Upstream's settings navbar (user/settings/navbar.tmpl) reduces to the
 * landed items — Profile, Security (the security module), Secrets (the
 * secrets sibling) and this tab under the Actions disclosure (navbar.tmpl
 * order: secrets before variables, :50-54) — the dead-link rule.
 *
 * ## Data (§3.2 — the LANDED 0021 store + the secrets-variables service)
 *
 * The list is `listVariableRows(d1, ownerScope(doer.id), …)` over migration
 * 0021's `action_variables` table (services/secrets-variables.ts — the same
 * service the user-scope `/actions` variable API ops serve through).
 * Upstream's web list is UNPAGINATED (`db.Find[actions_model.ActionVariable]`,
 * shared/actions/variables.go:94-96) while the landed service paginates, so
 * the loader passes a beyond-any-store limit (VARIABLE_WEB_LIST_LIMIT) — the
 * secrets sibling's documented seam, not a behavior change at realistic
 * sizes.
 *
 * The writes ride the landed ops verbatim — `createVariableRow`
 * (upstream CreateVariable → InsertVariable: ValidateName, rune-count cap,
 * description TruncateRunes, EOL-normalize, UPPERCASE name),
 * `updateVariableRow` (the UpdateVariableNameData sequence) and
 * `deleteVariableRow` (DeleteVariableByName). The web routes are ID-keyed
 * while the landed update/delete are NAME-keyed (the API PUT's path-name
 * shape), so the module does the id→row hop inside the doer's scope first —
 * exactly the secrets sibling's delete reduction (a foreign or stale id
 * answers "missing"). The EOL normalization needs NO module-level twin here,
 * unlike the secrets page: the landed variable ops mirror InsertVariable /
 * UpdateVariableNameData, which normalize inside the service.
 *
 * Documented divergences (both service-side parity points): upstream's
 * `EditVariableForm` binding (forms/user_form.go:235-240 — Name
 * `Required;MaxSize(255)`, Data `Required;MaxSize(65535)`) runs BEFORE the
 * handler and would 400 an over-cap or empty field; the reduction answers
 * with the service's own caps (the pattern attr carries the browser arm; the
 * ValidateName trio + "data too long" carry the server arm, and an empty
 * edit-name rides the service's zero-value fallback — keeps the stored name,
 * the API PUT's absent-field arm). Upstream's create has NO already-exists
 * pre-check on the web path (variables.go:107-129 calls CreateVariable
 * directly) — a duplicate name dies on the UNIQUE(owner_repo_name) constraint
 * upstream (JSONErrorAuto → 500) and the landed `createVariableRow` has the
 * same shape, so the module rethrows the non-ApiError and the route's generic
 * error handler answers the same way.
 *
 * Validation failures surface the service's exact ApiError texts (the
 * ValidateName trio + "data too long", services/secrets-variables.ts:102-115,
 * 173-175) as the re-rendered error line.
 *
 * ## DOM contract (user/settings/{layout_head,navbar,actions}.tmpl +
 *  shared/variables/variable_list.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `user settings actions` (both the
 * secrets and variables pages ARE the actions template); the navbar carries
 * the Actions disclosure open with the Variables sub-item active
 * (navbar.tmpl:53's PageIsSharedSettingsVariables). Content:
 * `.user-setting-content` with the `h4.ui.top.attached.header`
 * (actions.variables.management) over the `.ui.attached.segment`: the
 * `.flex-divided-list.items-with-main` rows (one per variable:
 * `.item-leading` octicon-pencil 32, `.item-main` name / description-or-dash
 * / the value IN PLAINTEXT — variable_list.tmpl:31-33, unlike the secrets
 * page's ****** mask — `.item-trailing` the Added-on stamp + edit + remove)
 * or the `actions.variables.none` empty line, then the add form. Field names
 * are exactly the upstream dialog's (`name` with the
 * `^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$` pattern attribute,
 * variable_list.tmpl:79, placeholder MY_VARIABLE_NAME:81; `data` maxlength
 * VariableDataMaxLength 65536 RUNES:89; `description` maxlength
 * VariableDescriptionMaxLength 4096, rows 2:98-99).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The `#edit-variable-modal` dialog + `show-modal` buttons are upstream's
 *   JS modal pair (variable_list.tmpl:3-13, 39-49, 67-106) — reduced to the
 *   no-JS shape the secrets sibling uses: the ADD form renders inline in the
 *   segment (the add-panel reduction) and each row's EDIT renders as a
 *   `<details>` disclosure carrying the same three fields. Unlike the secrets
 *   dialog, the variable dialog is ONE modal for both arms and pre-fills ALL
 *   THREE fields from the row (`data-modal-dialog-variable-name/-data/-description`,
 *   variable_list.tmpl:44-46) — the edit disclosure renders the row's
 *   name/data/description editable, name NOT read-only (there is no
 *   read-only arm in this dialog), and posts to the row's own URL
 *   (`{{$.Link}}/{{.ID}}/edit`, variable_list.tmpl:42).
 * - The add form posts to `/user/settings/actions/variables/new` (the header
 *   button's `data-modal-form.url`, variable_list.tmpl:6) — NOT to the list
 *   URL like the secrets dialog.
 * - The remove button is a plain form POST to the row's
 *   `/{id}/delete` URL with the id in the PATH (upstream's `link-action` +
 *   `data-modal-confirm` pair and PathParamInt64 are not reproduced — the
 *   secrets sibling's delete reduction; no hidden id field, the action URL
 *   carries the id) labeled with the deletion tooltip's text
 *   ("Remove variable", variable_list.tmpl:51) over the upstream
 *   octicon-trash glyph.
 * - The row and edit dates render upstream's `DateUtils.AbsoluteShort`
 *   ("Jan 2, 2006") in UTC (the milestones hand-rolled-clock precedent; the
 *   secrets sibling's formatSecretDate twin).
 * - The header's right-side Add button (variable_list.tmpl:3-14) folds into
 *   the inline add panel exactly like the secrets header's (the h4 keeps only
 *   the management title); the single dialog `autofocus` stays on the add
 *   panel's name input (N disclosure forms would each carry it; browsers
 *   honor only the first).
 * - The upstream `actions.variables.description` lead line
 *   ("Variables will be passed to certain actions and cannot be read
 *   otherwise." — the dialog's first field, variable_list.tmpl:72) rides
 *   above the inline add form, the secrets sibling's lead-line placement.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  createVariableRow,
  deleteVariableRow,
  listVariableRows,
  ownerScope,
  updateVariableRow,
  VARIABLE_DATA_MAX_RUNES,
  type VariableRow,
} from "../../api/services/secrets-variables";
import { actionVariables } from "../../db/schema";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsVariablesLocale = {
  settings: "User Settings", // "user.settings" (the navbar header)
  profile: "Profile", // "settings.profile"
  security: "Security", // "settings.security"
  actions: "Actions", // "actions.actions" (the navbar disclosure)
  secrets: "Secrets", // "secrets.secrets" (the landed sibling tab)
  variables: "Variables", // "actions.variables" (the Title — upstream ctx.Data["Title"], variables.go:84 — + the navbar sub-item)
  variables_management: "Variables Management", // "actions.variables.management"
  add_variable: "Add Variable", // "actions.variables.creation"
  edit_variable: "Edit Variable", // "actions.variables.edit"
  variables_description: "Variables will be passed to certain actions and cannot be read otherwise.", // "actions.variables.description" (the dialog's lead line — the pin's exact string)
  name: "Name", // "name"
  value: "Value", // "value"
  description_label: "Description", // "secrets.creation.description"
  name_pattern:
    "Name must start with a letter or underscore, contain only letters, numbers, and underscores, and must not start with GITEA_ or GITHUB_", // "secrets.creation.name_pattern" (the dialog's tooltip, variable_list.tmpl:80)
  value_placeholder: "Input any content. Whitespace at the start and end will be omitted.", // "secrets.creation.value_placeholder"
  description_placeholder: "Enter short description (optional).", // "secrets.creation.description_placeholder"
  none: "There are no variables yet.", // "actions.variables.none"
  added_on: "Added on", // "settings.added_on %s" — the date renders beside it
  deletion: "Remove variable", // "actions.variables.deletion" (the delete button's tooltip → its label)
  // The validation texts the apply functions answer (the service's exact
  // ApiError messages — the module header).
  invalid_name_pattern: "name must start with a letter or underscore and contain only letters, numbers, and underscores", // services/secrets-variables.ts:106
  invalid_name_prefix: "name cannot start with 'GITEA_' or 'GITHUB_'", // services/secrets-variables.ts:110
  reserved_ci: "'CI' is a reserved name", // services/secrets-variables.ts:113
  data_too_long: "data too long", // services/secrets-variables.ts:174
} as const;

/** The upstream dialog `name` input's pattern attribute, verbatim
 *  (variable_list.tmpl:79) — client-side mirror of the service's
 *  ValidateName. */
export const VARIABLE_NAME_PATTERN = "^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$";

/** The add/edit `data` textarea's maxlength (VariableDataMaxLength — the
 *  template's `{{.DataMaxLength}}`, variable_list.tmpl:89; RUNES upstream,
 *  the HTML attribute counts UTF-16 units — the pin passes the same number). */
export const VARIABLE_DATA_MAXLENGTH = VARIABLE_DATA_MAX_RUNES;

/** The `description` textarea's maxlength (VariableDescriptionMaxLength —
 *  variable_list.tmpl:99; upstream passes it as `{{.DescriptionMaxLength}}`). */
export const VARIABLE_DESCRIPTION_MAXLENGTH = 4096;

/** The loader's list cap — upstream's web list is unpaginated (`db.Find`,
 *  shared/actions/variables.go:94-96) while the landed service paginates; a
 *  beyond-any-store page size answers the same rows (the module header). */
export const VARIABLE_WEB_LIST_LIMIT = 10000;

// ---------------------------------------------------------------------------
// The write arms (upstream VariableCreate/VariableUpdate/VariableDelete over
// the landed service)
// ---------------------------------------------------------------------------

/** The variable POST body (the upstream dialog's three fields — the shared
 *  EditVariableForm, forms/user_form.go:235-240). */
export interface UserSettingsVariableForm {
  name: string;
  data: string;
  description: string;
}

/** Parse the urlencoded variable POST (the readUrlEncodedForm convention). */
export function parseUserSettingsVariableForm(params: URLSearchParams): UserSettingsVariableForm {
  return {
    name: params.get("name") ?? "",
    data: params.get("data") ?? "",
    description: params.get("description") ?? "",
  };
}

/** The `{variable_id}` path segment (upstream's PathParamInt64): digits only,
 *  junk/absent → null → the `"missing"` arm (the handoff note). */
export function parseUserSettingsVariablePathId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/** The outcomes the write handlers render (the secrets sibling's outcome
 *  pattern + upstream's findActionsVariable 404 arm). */
export type SaveVariableOutcome =
  | { outcome: "saved" }
  | { outcome: "invalid"; message: string }
  | { outcome: "missing" };

/**
 * The create — upstream VariableCreate → actions_service.CreateVariable
 * (variables.go:107-129, services/actions/variables.go:13-21) over the landed
 * `createVariableRow` at `ownerScope(doer.id)`: the service validates the
 * name (the ValidateName trio), rune-counts the value against
 * VariableDataMaxLength, truncates the description, EOL-normalizes and stores
 * the UPPERCASE name. A service ApiError becomes the `invalid` outcome with
 * the exact text; anything else (the UNIQUE duplicate-name db error —
 * upstream has no web pre-check either) propagates (the module header).
 */
export async function applyUserSettingsVariableCreate(d1: D1Database, userId: number, form: UserSettingsVariableForm): Promise<SaveVariableOutcome> {
  try {
    await createVariableRow(d1, ownerScope(userId), form.name, form.data, form.description);
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
 * row by id within the doer's scope (findActionsVariable's
 * FindVariablesOpts{IDs, BelongingScope}, variables.go:163-177 — a miss is
 * the `"missing"` outcome, upstream's ctx.NotFound(nil)), then the landed
 * `updateVariableRow` over the row's stored (UPPERCASE) name: the form's
 * name/data/description overwrite all three — UpdateVariableNameData
 * re-validates and EOL-normalizes (services/actions/variables.go:23-31). An
 * empty form name rides the service's zero-value fallback (keeps the stored
 * name — the module header's binding divergence). A service ApiError becomes
 * `invalid` with the exact text; a resolve-to-update race (the row vanished
 * between the hops) is `"missing"` like upstream's own re-find arm.
 */
export async function applyUserSettingsVariableUpdate(
  d1: D1Database,
  userId: number,
  variableId: number | null,
  form: UserSettingsVariableForm,
): Promise<SaveVariableOutcome> {
  if (variableId === null) {
    return { outcome: "missing" };
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(actionVariables)
      .where(and(eq(actionVariables.id, variableId), eq(actionVariables.ownerId, userId), eq(actionVariables.repoId, "")))
      .limit(1)
  )[0];
  if (row === undefined) {
    return { outcome: "missing" };
  }
  try {
    const updated = await updateVariableRow(d1, ownerScope(userId), row.name, form.name, form.data, form.description);
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
 * row within the doer's scope (findActionsVariable — a foreign, stale or
 * junk id answers `"missing"`, upstream's ctx.NotFound(nil)), then the landed
 * name-keyed `deleteVariableRow` on the row's stored name.
 */
export async function deleteUserSettingsVariable(d1: D1Database, userId: number, variableId: number | null): Promise<"deleted" | "missing"> {
  if (variableId === null) {
    return "missing";
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(actionVariables)
      .where(and(eq(actionVariables.id, variableId), eq(actionVariables.ownerId, userId), eq(actionVariables.repoId, "")))
      .limit(1)
  )[0];
  if (row === undefined) {
    return "missing";
  }
  const deleted = await deleteVariableRow(d1, ownerScope(userId), row.name);
  return deleted === null ? "missing" : "deleted";
}

// ---------------------------------------------------------------------------
// The list loader (upstream Variables' Find, shared/actions/variables.go:94-96
// — unpaginated, see VARIABLE_WEB_LIST_LIMIT)
// ---------------------------------------------------------------------------

/** The variables tab's render inputs. `form` re-renders the submitted add
 *  values (the empty triple on the plain GET) — the secrets sibling's
 *  convention; an invalid EDIT re-render surfaces the error line and keeps
 *  the row-driven disclosures. */
export interface UserSettingsVariablesPageData {
  variables: VariableRow[];
  form: UserSettingsVariableForm;
}

/** The page load — the doer's owner-scope rows, name-ordered (the service's
 *  FindVariablesOpts order). */
export async function loadUserSettingsVariablesPageData(d1: D1Database, userId: number): Promise<UserSettingsVariablesPageData> {
  const { rows } = await listVariableRows(d1, ownerScope(userId), 1, VARIABLE_WEB_LIST_LIMIT);
  return { variables: rows, form: { name: "", data: "", description: "" } };
}

// ---------------------------------------------------------------------------
// The render (user/settings/actions.tmpl PageType "variables" +
//  shared/variables/variable_list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** Upstream `DateUtils.AbsoluteShort` ("Jan 2, 2006") — UTC, hand-rolled so
 *  the bytes never depend on the runtime's ICU (the milestones.tsx
 *  formatDueDate precedent; the secrets sibling's formatSecretDate twin). */
export function formatVariableDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** The settings navbar (user/settings/navbar.tmpl reduced to the landed
 *  items — the module header). `active` marks this tab; the Actions
 *  disclosure opens while the variables sub-item is active (navbar.tmpl:41's
 *  PageIsSharedSettingsVariables arm); the landed Secrets tab renders before
 *  it (navbar.tmpl order :50-54). */
export function UserSettingsVariablesNav(props: { active: "profile" | "security" | "secrets" | "variables" }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{userSettingsVariablesLocale.settings}</div>
        <a class={props.active === "profile" ? "active item" : "item"} href="/user/settings">
          {userSettingsVariablesLocale.profile}
        </a>
        <a class={props.active === "security" ? "active item" : "item"} href="/user/settings/security">
          {userSettingsVariablesLocale.security}
        </a>
        <details class="item" open={props.active === "secrets" || props.active === "variables" ? true : undefined}>
          <summary>{userSettingsVariablesLocale.actions}</summary>
          <div class="menu">
            <a class={props.active === "secrets" ? "active item" : "item"} href="/user/settings/actions/secrets">
              {userSettingsVariablesLocale.secrets}
            </a>
            <a class={props.active === "variables" ? "active item" : "item"} href="/user/settings/actions/variables">
              {userSettingsVariablesLocale.variables}
            </a>
          </div>
        </details>
      </div>
    </div>
  );
}

/** The shared name/value/description fields (the upstream dialog's three
 *  field divs, variable_list.tmpl:74-102 — rendered twice: the inline add
 *  form and each row's edit disclosure; ONE dialog upstream pre-fills all
 *  three on edit, so there is no read-only/empty arm here, unlike the secrets
 *  page). `autofocus` stays on the add panel only (the module header). */
function VariableFormFields(props: { idPrefix: string; form: UserSettingsVariableForm; autofocus: boolean }) {
  return (
    <>
      <div class="field">
        <label for={`${props.idPrefix}-name`}>{userSettingsVariablesLocale.name}</label>
        <input
          autofocus={props.autofocus ? true : undefined}
          required
          id={`${props.idPrefix}-name`}
          name="name"
          value={props.form.name}
          pattern={VARIABLE_NAME_PATTERN}
          title={userSettingsVariablesLocale.name_pattern}
          placeholder="MY_VARIABLE_NAME"
        />
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-data`}>{userSettingsVariablesLocale.value}</label>
        <textarea
          required
          id={`${props.idPrefix}-data`}
          name="data"
          maxlength={VARIABLE_DATA_MAXLENGTH}
          placeholder={userSettingsVariablesLocale.value_placeholder}
        >
          {props.form.data}
        </textarea>
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-description`}>{userSettingsVariablesLocale.description_label}</label>
        <textarea
          id={`${props.idPrefix}-description`}
          name="description"
          rows={2}
          maxlength={VARIABLE_DESCRIPTION_MAXLENGTH}
          placeholder={userSettingsVariablesLocale.description_placeholder}
        >
          {props.form.description}
        </textarea>
      </div>
    </>
  );
}

/** One variable_list.tmpl row (variable_list.tmpl:20-58): the pencil glyph,
 *  the name/description/value body — the value renders IN PLAINTEXT
 *  (variable_list.tmpl:31-33; variables are not masked, unlike secrets) —
 *  the Added-on stamp, the edit disclosure (the modal reduction, prefilled
 *  with all three fields) and the remove form (the modal-confirm reduction;
 *  the id rides the action URL, no hidden field). */
export function VariableRowItem(props: { row: VariableRow }) {
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
          {userSettingsVariablesLocale.added_on} {formatVariableDate(row.createdAt)}
        </span>
        <details>
          <summary class="flex-text-inline">
            <Icon name="octicon-pencil" /> {userSettingsVariablesLocale.edit_variable}
          </summary>
          {/* The dialog's form (variable_list.tmpl:69) targeting the row's
              own URL ({{$.Link}}/{{.ID}}/edit, :42), prefilled from the row
              (:44-46). */}
          <form class="ui form" action={`/user/settings/actions/variables/${row.id}/edit`} method="post">
            <VariableFormFields
              idPrefix={`variable-edit-${row.id}`}
              form={{ name: row.name, data: row.data, description: row.description }}
              autofocus={false}
            />
            <div class="field">
              <button type="submit" class="ui primary button">
                {userSettingsVariablesLocale.edit_variable}
              </button>
            </div>
          </form>
        </details>
        <form class="tw-inline-block" action={`/user/settings/actions/variables/${row.id}/delete`} method="post">
          <button type="submit" class="ui red tiny button">
            <Icon name="octicon-trash" /> {userSettingsVariablesLocale.deletion}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed POST's message (null on the plain GET). */
export function renderUserSettingsVariablesPage(ctx: UiContext, data: UserSettingsVariablesPageData, error: string | null = null): string {
  return renderPage(<UserSettingsVariablesPage ctx={ctx} data={data} error={error} />);
}

/** The variables page (§2.4.1 discriminator: `user settings actions` —
 *  layout_head's pageClass, actions.tmpl:1; upstream's Title is
 *  `actions.variables`, variables.go:84). */
export function UserSettingsVariablesPage(props: { ctx: UiContext; data: UserSettingsVariablesPageData; error: string | null }) {
  return (
    <BaseLayout ctx={props.ctx} title={userSettingsVariablesLocale.variables} pageClass="user settings actions">
      <div class="ui container flex-container">
        <UserSettingsVariablesNav active="variables" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {/* shared/variables/variable_list.tmpl:1-64 */}
            <h4 class="ui top attached header">{userSettingsVariablesLocale.variables_management}</h4>
            <div class="ui attached segment">
              {props.data.variables.length > 0 ? (
                <div class="flex-divided-list items-with-main">
                  {props.data.variables.map((row) => (
                    <VariableRowItem key={row.id} row={row} />
                  ))}
                </div>
              ) : (
                <p>{userSettingsVariablesLocale.none}</p>
              )}
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {/* The #edit-variable-modal dialog reduced to the inline add
                  form (the module header) — the dialog's lead line rides
                  above it (variable_list.tmpl:72). */}
              <div class="tw-mt-4" id="add-variable-panel">
                <p>{userSettingsVariablesLocale.variables_description}</p>
                <form class="ui form" action="/user/settings/actions/variables/new" method="post">
                  <VariableFormFields idPrefix="variable-add" form={props.data.form} autofocus={true} />
                  <div class="field">
                    <button type="submit" class="ui primary button">
                      {userSettingsVariablesLocale.add_variable}
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
