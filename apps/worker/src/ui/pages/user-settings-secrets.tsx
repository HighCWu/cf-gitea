/**
 * The user settings ACTIONS SECRETS tab, `/user/settings/actions/secrets` —
 * pages wave 56 (bench row `wave-settings-security-module`, MOUNTED at
 * 0c2b151 — the route lives in `index.ts`).
 *
 * Upstream pin: the user-scope arm of the shared settings-secrets family —
 * `user/settings/actions.tmpl` (PageType "secrets") including
 * `shared/secrets/add_list.tmpl`, fed by `repo_setting.Secrets` /
 * `SecretsPost` / `SecretsDelete` through `getSecretsCtx`'s user arm
 * (routers/web/repo/setting/secrets.go:63-71, 76-132) and
 * `shared.SetSecretsContext` / `PerformSecretsPost` / `PerformSecretsDelete`
 * (routers/web/shared/secrets/secrets.go), mounted at web.go:708-717's
 * `/actions` group inside the reqSignIn `/user/settings` group.
 *
 * ## Mount record (MOUNTED at 0c2b151 — the wiring HANDOFF is retired)
 *
 * Upstream's route group is web.go:498-503 shared across the three scopes;
 * the user scope mounts inside web.go:708-717. Three routes mount:
 *
 *   GET /user/settings/actions/secrets → resolveUiSession (signed-in gate,
 *            the user-settings.tsx pattern) → loadUserSettingsSecretsPageData
 *            → renderUserSettingsSecretsPage; a session doer without a D1 row
 *            404-shells (the silent-auth-failure convention).
 *   POST /user/settings/actions/secrets → the sameOriginGuard + the signed-in
 *            gate, `readUrlEncodedForm`, `parseUserSettingsSecretForm`, then
 *            `applyUserSettingsSecretForm` (upstream SecretsPost →
 *            PerformSecretsPost, secrets.go:98-117 / 35-56). `outcome:
 *            "saved"` 303s back onto `/user/settings/actions/secrets`
 *            (upstream's JSONRedirect; the no-session-flash reduction — the
 *            `secrets.save_success` line does not render, the
 *            user-settings.tsx convention). An `outcome: "invalid"` re-renders
 *            the page with the `error` line + the submitted `form` values
 *            (upstream's JSONErrorAuto is a form-fetch-action JS arm — the
 *            no-JS reduction re-renders, the keys sibling's
 *            RenderWithErrDeprecated arm).
 *   POST /user/settings/actions/secrets/delete → `parseUserSettingsSecretDeleteForm`
 *            + `deleteUserSettingsSecret` (upstream SecretsDelete →
 *            PerformSecretsDelete, secrets.go:119-132 / 58-71) — both
 *            outcomes 303 back (upstream's flash-error arm cannot render
 *            without flash plumbing; a repeated or raced delete is idempotent
 *            and nothing about foreign ids leaks).
 *
 * The doer IS the owner — the scope is `ownerScope(doer.id)`
 * (services/secrets-variables.ts's BelongingScopeOwner encoding), the same
 * authorization shape as the landed user-scope API ops (`/user/actions/*`,
 * routes/secrets-variables.ts:875-877 — reqToken, no further gate).
 *
 * Upstream's settings navbar (user/settings/navbar.tmpl) is the SHARED
 * components/settings-nav UserSettingsNavbar (the wave-114 swap) with the
 * Actions disclosure open and the Secrets sub-item active.
 *
 * ## Data (§3.2 — the LANDED 0021 store + the secrets-variables service)
 *
 * The list is `listSecretRows(d1, ownerScope(doer.id), …)` over migration
 * 0021's `secrets` table (services/secrets-variables.ts — the same service
 * the 23-op `/actions` API family serves through). Upstream's web list is
 * UNPAGINATED (`db.Find[secret_model.Secret]`, shared/secrets/secrets.go:25-28)
 * while the landed service paginates, so the loader passes a beyond-any-store
 * limit (SECRET_WEB_LIST_LIMIT) — the documented seam, not a behavior change
 * at realistic sizes.
 *
 * The write is `createOrUpdateSecret` (the PUT arm's upsert: validate →
 * find-by-UPPER-name → insert (created) / update data+description) and the
 * delete resolves the form's row id within the doer's scope, then
 * `deleteSecretByName` (upstream deletes by id — DeleteSecretByID,
 * shared/secrets/secrets.go:59-63; the landed service is name-keyed, so the
 * module does the id→row→name hop inside the same scope — a foreign or stale
 * id answers "missing"). One WEB-path normalization rides along:
 * PerformSecretsPost EOL-normalizes the submitted value
 * (`util.NormalizeStringEOL(form.Data)`, shared/secrets/secrets.go:42) before
 * the service call — the API PUT path does not, which is exactly the landed
 * service's shape (the services header's length-units note), so the module
 * applies the normalization and the service stays untouched.
 *
 * Validation failures surface the service's exact ApiError texts (the
 * ValidateName trio + "data too long", services/secrets-variables.ts:102-115,
 * 171-175) as the re-rendered error line.
 *
 * ## DOM contract (user/settings/{layout_head,navbar,actions}.tmpl +
 *  shared/secrets/add_list.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `user settings actions` (the
 * secrets page IS the actions template — PageType "secrets"); the navbar
 * carries the Actions disclosure open with the Secrets sub-item active.
 * Content: `.user-setting-content` with the `h4.ui.top.attached.header`
 * (secrets.management) over the `.ui.attached.segment`: the
 * `.flex-divided-list.items-with-main` rows (one per secret:
 * `.item-leading` key glyph, `.item-main` title/description/****** body,
 * `.item-trailing` the Added-on stamp + edit + remove) or the
 * `secrets.none` empty line, then the add form. Field names are exactly the
 * upstream dialog's (`name` with the `^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$`
 * pattern attribute, add_list.tmpl:81; `data` maxlength
 * SecretDataMaxLength 65536; `description` maxlength
 * SecretDescriptionMaxLength 4096, models/secret/secret.go:50-51).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The `#add-secret-modal` dialog + `show-modal` buttons are upstream's JS
 *   modal pair — reduced to the no-JS shape the siblings use: the ADD form
 *   renders inline in the segment (the keys sibling's add-panel reduction)
 *   and each row's EDIT renders as a `<details>` disclosure carrying the same
 *   three fields (the org-labels disclosure reduction). Both post to the
 *   upstream form URL (`{{.Link}}` = the list page) — the edit modal's
 *   `data-modal-form.url`, add_list.tmpl:42.
 * - The edit disclosure's name input is READ-ONLY (upstream's
 *   `data-modal-secret-name.read-only="true"`, add_list.tmpl:46) and its
 *   value textarea renders EMPTY (upstream's `data-modal-secret-data=""`,
 *   add_list.tmpl:47) — the plaintext never renders into the DOM even though
 *   the landed row carries it (the at-rest divergence is invisible by
 *   construction, the services header's note); the required re-entry matches
 *   upstream's edit flow exactly.
 * - The remove button is a plain form POST to `/secrets/delete` with the
 *   hidden row id (upstream's `link-action` + `data-modal-confirm` dialog
 *   pair are not reproduced — the hooks-list reduction, wave 4).
 * - The row date renders upstream's `DateUtils.AbsoluteShort` ("Jan 2, 2006")
 *   in UTC (the milestones hand-rolled-clock precedent).
 * - The VARIABLES sub-tab (navbar.tmpl:52-54,
 *   shared/variables/variable_list.tmpl, web.go:716's addSettingsVariablesRoutes)
 *   is a separate page this module does not claim — every user-scope variable
 *   op it needs is already landed (getUserVariablesList/createUserVariable/
 *   updateUserVariable/deleteUserVariable), so it is a clean follow-up bench
 *   row (the orchestrator's wave log).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  createOrUpdateSecret,
  deleteSecretByName,
  listSecretRows,
  ownerScope,
  SECRET_DATA_MAX_BYTES,
  type SecretRow,
} from "../../api/services/secrets-variables";
import { secrets } from "../../db/schema";
import { UserSettingsNavbar } from "../components/settings-nav";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { IconName } from "../icons";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsSecretsLocale = {
  actions: "Actions", // "actions.actions" (the title — upstream ctx.Data["Title"], secrets.go:77 — + the shared navbar's disclosure)
  secrets_management: "Secrets Management", // "secrets.management"
  add_secret: "Add Secret", // "secrets.add_secret"
  edit_secret: "Edit secret", // "secrets.edit_secret"
  secrets_description: "Secrets will be passed to certain actions and cannot be read otherwise.", // "secrets.description" (the dialog's lead line)
  name: "Name", // "name"
  value: "Value", // "value"
  description_label: "Description", // "secrets.creation.description"
  name_pattern:
    "Name must start with a letter or underscore, contain only letters, numbers, and underscores, and must not start with GITEA_ or GITHUB_", // "secrets.creation.name_pattern"
  value_placeholder: "Input any content. Whitespace at the start and end will be omitted.", // "secrets.creation.value_placeholder"
  description_placeholder: "Enter short description (optional).", // "secrets.creation.description_placeholder"
  none: "There are no secrets yet.", // "secrets.none"
  added_on: "Added on", // "settings.added_on %s" — the date renders beside it
  remove: "Remove", // "remove"
  confirm: "Confirm", // "modal.confirm" (the dialog submit arm — the inline forms' submit label)
  // The validation texts the apply function answers (the service's exact
  // ApiError messages — the module header).
  invalid_name_pattern: "name must start with a letter or underscore and contain only letters, numbers, and underscores", // services/secrets-variables.ts:106
  invalid_name_prefix: "name cannot start with 'GITEA_' or 'GITHUB_'", // services/secrets-variables.ts:110
  reserved_ci: "'CI' is a reserved name", // services/secrets-variables.ts:113
  data_too_long: "data too long", // services/secrets-variables.ts:174
} as const;

/** The upstream dialog `name` input's pattern attribute, verbatim
 *  (add_list.tmpl:81) — client-side mirror of the service's ValidateName. */
export const SECRET_NAME_PATTERN = "^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$";

/** The add/edit `data` textarea's maxlength (SecretDataMaxLength — the
 *  template's `{{.DataMaxLength}}`, add_list.tmpl:91). */
export const SECRET_DATA_MAXLENGTH = SECRET_DATA_MAX_BYTES;

/** The `description` textarea's maxlength (SecretDescriptionMaxLength —
 *  add_list.tmpl:101; upstream passes it as `{{.DescriptionMaxLength}}`). */
export const SECRET_DESCRIPTION_MAXLENGTH = 4096;

/** The loader's list cap — upstream's web list is unpaginated (`db.Find`,
 *  shared/secrets/secrets.go:25-28) while the landed service paginates; a
 *  beyond-any-store page size answers the same rows (the module header). */
export const SECRET_WEB_LIST_LIMIT = 10000;

// ---------------------------------------------------------------------------
// The write arms (upstream SecretsPost/SecretsDelete over the landed service)
// ---------------------------------------------------------------------------

/** The secrets POST body (the upstream dialog's three fields). */
export interface UserSettingsSecretForm {
  name: string;
  data: string;
  description: string;
}

/** Parse the urlencoded secrets POST (the readUrlEncodedForm convention). */
export function parseUserSettingsSecretForm(params: URLSearchParams): UserSettingsSecretForm {
  return {
    name: params.get("name") ?? "",
    data: params.get("data") ?? "",
    description: params.get("description") ?? "",
  };
}

/** The save outcomes the POST handler renders (the keys sibling's outcome
 *  pattern). */
export type SaveSecretOutcome = { outcome: "saved" } | { outcome: "invalid"; message: string };

/** util.NormalizeStringEOL (modules/util/util.go:312) — the WEB write path's
 *  normalization (shared/secrets/secrets.go:42); the landed service mirrors
 *  the API path, which does not normalize, so the module applies it. */
function normalizeStringEol(input: string): string {
  return input.replaceAll("\r\n", "\n");
}

/**
 * The save — upstream SecretsPost → PerformSecretsPost
 * (shared/secrets/secrets.go:35-56) over the landed `createOrUpdateSecret`
 * at `ownerScope(doer.id)`: the service validates the name (the ValidateName
 * trio) and length-caps the data, upserting by UPPER(name) — create on a
 * miss, data+description update on a hit, the PUT arm's exact semantics
 * (the dialog's edit posts the read-only name back through the same URL).
 * A service ApiError (invalid name / data too long) becomes the
 * `invalid` outcome with the exact text; anything else propagates.
 */
export async function applyUserSettingsSecretForm(d1: D1Database, userId: number, form: UserSettingsSecretForm): Promise<SaveSecretOutcome> {
  try {
    await createOrUpdateSecret(d1, ownerScope(userId), form.name, normalizeStringEol(form.data), form.description);
  } catch (error) {
    if (error instanceof ApiError) {
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
  return { outcome: "saved" };
}

/** The secrets/delete POST body (upstream's `id` —
 *  PerformSecretsDelete's FormInt64, shared/secrets/secrets.go:60). */
export interface UserSettingsSecretDeleteForm {
  id: number | null;
}

export function parseUserSettingsSecretDeleteForm(params: URLSearchParams): UserSettingsSecretDeleteForm {
  const raw = params.get("id") ?? "";
  return { id: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null };
}

/**
 * The delete — upstream SecretsDelete → PerformSecretsDelete
 * (shared/secrets/secrets.go:58-71): resolve the row within the doer's scope
 * (upstream's DeleteSecretByID is scope-guarded the same way), then the
 * landed name-keyed `deleteSecretByName`. `"missing"` covers a null id, a
 * foreign id, and a stale (already-deleted) id — every arm 303s back (the
 * module header).
 */
export async function deleteUserSettingsSecret(d1: D1Database, userId: number, form: UserSettingsSecretDeleteForm): Promise<"deleted" | "missing"> {
  if (form.id === null) {
    return "missing";
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, form.id), eq(secrets.ownerId, userId), eq(secrets.repoId, "")))
      .limit(1)
  )[0];
  if (row === undefined) {
    return "missing";
  }
  const deleted = await deleteSecretByName(d1, ownerScope(userId), row.name);
  return deleted === null ? "missing" : "deleted";
}

// ---------------------------------------------------------------------------
// The list loader (upstream SetSecretsContext's Find, shared/secrets/
// secrets.go:24-33 — unpaginated, see SECRET_WEB_LIST_LIMIT)
// ---------------------------------------------------------------------------

/** The secrets tab's render inputs. `form` re-renders the submitted add/edit
 *  values (the empty triple on the plain GET). */
export interface UserSettingsSecretsPageData {
  secrets: SecretRow[];
  form: UserSettingsSecretForm;
}

/** The page load — the doer's owner-scope rows, name-ordered (the service's
 *  FindSecretsOptions order). */
export async function loadUserSettingsSecretsPageData(d1: D1Database, userId: number): Promise<UserSettingsSecretsPageData> {
  const { rows } = await listSecretRows(d1, ownerScope(userId), 1, SECRET_WEB_LIST_LIMIT);
  return { secrets: rows, form: { name: "", data: "", description: "" } };
}

// ---------------------------------------------------------------------------
// The render (user/settings/actions.tmpl PageType "secrets" +
//  shared/secrets/add_list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** Upstream `DateUtils.AbsoluteShort` ("Jan 2, 2006") — UTC, hand-rolled so
 *  the bytes never depend on the runtime's ICU (the milestones.tsx
 *  formatDueDate precedent; the keys sibling's formatKeyDate twin). */
export function formatSecretDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** The row's leading glyph. Upstream renders `{{svg "octicon-key" 32}}`
 *  (add_list.tmpl:23); octicon-key is outside the generated icon allowlist —
 *  octicon-shield-lock is the documented stand-in (the keys sibling's
 *  KEY_ICON convention). */
const SECRET_ICON: IconName = "octicon-shield-lock";

/** The settings navbar: the SHARED components/settings-nav UserSettingsNavbar
 *  (the wave-114 swap — the local Profile/Security/Actions copy deleted; the
 *  disclosure opens while the secrets sub-item is active, navbar.tmpl:40). */

/** The shared name/value/description fields (the upstream dialog's three
 *  field divs, add_list.tmpl:73-104 — rendered twice: the inline add form and
 *  each row's edit disclosure). `name` renders read-only in the edit shape
 *  (add_list.tmpl:46) and pattern-carrying in the add shape (add_list.tmpl:81);
 *  the edit `data` textarea renders EMPTY — the plaintext never enters the
 *  DOM (the module header). */
function SecretFormFields(props: { idPrefix: string; form: UserSettingsSecretForm; readOnlyName: boolean }) {
  return (
    <>
      <div class="field">
        <label for={`${props.idPrefix}-name`}>{userSettingsSecretsLocale.name}</label>
        <input
          autofocus={props.readOnlyName ? undefined : true}
          required
          id={`${props.idPrefix}-name`}
          name="name"
          value={props.form.name}
          pattern={props.readOnlyName ? undefined : SECRET_NAME_PATTERN}
          title={userSettingsSecretsLocale.name_pattern}
          placeholder={props.readOnlyName ? undefined : "MY_SECRET_NAME"}
          readOnly={props.readOnlyName ? true : undefined}
        />
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-data`}>{userSettingsSecretsLocale.value}</label>
        <textarea
          required
          id={`${props.idPrefix}-data`}
          name="data"
          maxlength={SECRET_DATA_MAXLENGTH}
          placeholder={userSettingsSecretsLocale.value_placeholder}
        >
          {props.readOnlyName ? "" : props.form.data}
        </textarea>
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-description`}>{userSettingsSecretsLocale.description_label}</label>
        <textarea
          id={`${props.idPrefix}-description`}
          name="description"
          rows={2}
          maxlength={SECRET_DESCRIPTION_MAXLENGTH}
          placeholder={userSettingsSecretsLocale.description_placeholder}
        >
          {props.readOnlyName ? "" : props.form.description}
        </textarea>
      </div>
    </>
  );
}

/** One add_list.tmpl row (add_list.tmpl:21-59): the key glyph, the
 *  name/description/****** body, the Added-on stamp, the edit disclosure
 *  (the modal reduction) and the remove form (the modal-confirm reduction). */
export function SecretRowItem(props: { row: SecretRow }) {
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
          {userSettingsSecretsLocale.added_on} {formatSecretDate(row.createdAt)}
        </span>
        <details>
          <summary class="flex-text-inline">
            <Icon name="octicon-pencil" /> {userSettingsSecretsLocale.edit_secret}
          </summary>
          {/* The modal's form (add_list.tmpl:71): same URL, read-only name,
              empty value (the re-entry flow). */}
          <form class="ui form" action="/user/settings/actions/secrets" method="post">
            <SecretFormFields idPrefix={`secret-edit-${row.id}`} form={{ name: row.name, data: "", description: "" }} readOnlyName={true} />
            <div class="field">
              <button type="submit" class="ui primary button">
                {userSettingsSecretsLocale.confirm}
              </button>
            </div>
          </form>
        </details>
        <form class="tw-inline-block" action="/user/settings/actions/secrets/delete" method="post">
          <input type="hidden" name="id" value={String(row.id)} />
          <button type="submit" class="ui red tiny button">
            {userSettingsSecretsLocale.remove}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed POST's message (null on the plain GET). */
export function renderUserSettingsSecretsPage(ctx: UiContext, data: UserSettingsSecretsPageData, error: string | null = null): string {
  return renderPage(<UserSettingsSecretsPage ctx={ctx} data={data} error={error} />);
}

/** The secrets page (§2.4.1 discriminator: `user settings actions` —
 *  layout_head's pageClass, actions.tmpl:1; upstream's Title is
 *  `actions.actions`, secrets.go:77). */
export function UserSettingsSecretsPage(props: { ctx: UiContext; data: UserSettingsSecretsPageData; error: string | null }) {
  return (
    <BaseLayout ctx={props.ctx} title={userSettingsSecretsLocale.actions} pageClass="user settings actions">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="secrets" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {/* shared/secrets/add_list.tmpl:1-16 */}
            <h4 class="ui top attached header">{userSettingsSecretsLocale.secrets_management}</h4>
            <div class="ui attached segment">
              {props.data.secrets.length > 0 ? (
                <div class="flex-divided-list items-with-main">
                  {props.data.secrets.map((row) => (
                    <SecretRowItem key={row.id} row={row} />
                  ))}
                </div>
              ) : (
                <p>{userSettingsSecretsLocale.none}</p>
              )}
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {/* The add-secret dialog reduced to the inline form (the
                  module header) — the dialog's lead line rides above it
                  (add_list.tmpl:74). */}
              <div class="tw-mt-4" id="add-secret-panel">
                <p>{userSettingsSecretsLocale.secrets_description}</p>
                <form class="ui form" action="/user/settings/actions/secrets" method="post">
                  <SecretFormFields idPrefix="secret-add" form={props.data.form} readOnlyName={false} />
                  <div class="field">
                    <button type="submit" class="ui primary button">
                      {userSettingsSecretsLocale.add_secret}
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
