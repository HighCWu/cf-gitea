/**
 * The repo settings ACTIONS tab's SECRETS + VARIABLES sub-tabs — the census
 * C8 arm (the repo-scope twin of the landed org module
 * org-settings-actions.tsx, wave 59, and the user twins user-settings-*
 * secrets/variables, waves 56/58). One module for both arms, the org twin's
 * shape — the census's suggested ownership row.
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 * `gitea/templates/repo/settings/actions.tmpl` EXISTS and is the PageType
 * switchyard — runners / secrets / variables / general (actions.tmpl:3-11)
 * under the literal pageClass `repository settings actions` (actions.tmpl:1)
 * over the `.repo-setting-content` wrapper (actions.tmpl:2 — the repo family's
 * own wrapper class, the org/user twins' `.org-setting-content`/
 * `.user-setting-content` counterpart). This module claims the secrets and
 * variables arms; the runners, general and scoped-workflows arms have no
 * landed pages (the dead-link rule — they render nothing in the navbar
 * either).
 *
 *   - secrets arm: `shared/secrets/add_list.tmpl` fed by the REPO arm of
 *     `getSecretsCtx` (routers/web/repo/setting/secrets.go:39-48 —
 *     `BelongingScopeRepo(ctx.Repo.Repository.ID)`, RedirectLink
 *     `ctx.Repo.RepoLink + "/settings/actions/secrets"`, tplRepoSecrets
 *     "repo/settings/actions") through `Secrets` / `SecretsPost` /
 *     `SecretsDelete` (secrets.go:76-95, 98-117, 119-132) over
 *     `shared.PerformSecretsPost` / `PerformSecretsDelete`
 *     (routers/web/shared/secrets/secrets.go:35-56, 58-71 — the WEB write
 *     path's EOL normalization at :42 is scope-shared, so the repo arm
 *     normalizes too);
 *   - variables arm: `shared/variables/variable_list.tmpl` fed by the REPO
 *     arm of `getVariablesCtx` (routers/web/shared/actions/variables.go:40-47
 *     — `BelongingScopeRepo(ctx.Repo.Repository.ID)`, RedirectLink
 *     `ctx.Repo.RepoLink + "/settings/actions/variables"`) through `Variables`
 *     / `VariableCreate` / `VariableUpdate` / `VariableDelete`
 *     (variables.go:83-200).
 *
 * Mounting upstream: web.go:498-506's `addSettingsSecretsRoutes` and
 * web.go:489-496's `addSettingsVariablesRoutes` inside web.go:1266-1278's
 * `/{owner}/{repo}/settings` `/actions` group — behind
 * `actions.MustEnableActions` (web.go:1278) inside the settings subtree that
 * closes behind `reqSignIn, RepoAssignment, reqRepoAdmin` +
 * `PageIsRepoSettings` (web.go:1286-1287). `GET /settings/actions` itself is
 * upstream's LocationRedirect onto ./actions/general (web.go:1267) — the
 * general tab is NOT this module's claim (no landed page); the dispatcher
 * leaves it unclaimed and the engine 404-shells it, the org twin's posture
 * for the same literal.
 *
 * ## Gates (the settingsGate + the MustEnableActions repo-unit arm)
 *
 * The settings subtree's posture everywhere (settings.tsx /
 * repo-settings-lfs.tsx headers): anonymous 303s onto the login round-trip, a
 * signed-in non-admin 404-shells (the shared `settingsGate` over
 * `isRepositoryAdmin`). The `/actions` group ADDS `MustEnableActions`
 * (routers/web/repo/actions/actions.go:67-81): for the repo scope it is
 * `ctx.Repo.Permission.CanRead(unit.TypeActions)` — the landed store's unit
 * flag is `repo_settings.has_actions` (DEFAULT false, the options form's
 * `enable_actions` checkbox), so a disabled unit answers the 404 shell
 * (upstream ctx.NotFound) and the navbar items stay unrendered with it
 * (navbar.tmpl:47's `{{if and .EnableActions .Permission.CanRead Actions}}` —
 * the instance flag `.EnableActions` is vacuous here, actions are this
 * deployment's core; the repo-unit arm is the gate). The nav item conditional
 * rides the shared SettingsNav's `hasActions` prop — reduced like the
 * conditional Public Access item: call sites that cannot evaluate it render
 * the reduced nav.
 *
 * Seven routes (the org twin's exact shapes under `/{owner}/{repo}`):
 *
 *   GET  /{owner}/{repo}/settings/actions/secrets → the gates →
 *            loadRepoActionsSecretsPageData → renderRepoActionsSecretsPage.
 *   POST /{owner}/{repo}/settings/actions/secrets → the sameOriginGuard +
 *            the gates, `readUrlEncodedForm`, `parseRepoActionsSecretForm`,
 *            then `applyRepoActionsSecretForm` (upstream SecretsPost →
 *            PerformSecretsPost). `outcome: "saved"` 303s back onto the list
 *            URL (upstream's JSONRedirect — the no-session-flash reduction,
 *            the landed twins' convention). An `outcome: "invalid"` re-renders
 *            the page with the `error` line + the submitted `form` values
 *            (upstream's JSONErrorAuto is a form-fetch-action JS arm — the
 *            no-JS reduction re-renders).
 *   POST /{owner}/{repo}/settings/actions/secrets/delete →
 *            `parseRepoActionsSecretDeleteForm` + `deleteRepoActionsSecret` —
 *            both outcomes 303 back (a null/foreign/stale id answers
 *            "missing" and deletes nothing; the idempotent-303 reduction).
 *   GET  /{owner}/{repo}/settings/actions/variables →
 *            loadRepoActionsVariablesPageData → renderRepoActionsVariablesPage.
 *   POST /{owner}/{repo}/settings/actions/variables/new →
 *            `parseRepoActionsVariableForm` + `applyRepoActionsVariableCreate`
 *            (upstream VariableCreate); "saved" 303s back, "invalid"
 *            re-renders with the error line + the submitted add-form values, a
 *            non-ApiError (the UNIQUE duplicate-name db error — upstream has
 *            no web pre-check either) propagates to the generic error handler.
 *   POST /{owner}/{repo}/settings/actions/variables/{id}/edit → the path id
 *            through `parseRepoActionsVariablePathId`, then
 *            `applyRepoActionsVariableUpdate` (upstream VariableUpdate).
 *            "saved" 303s back; "invalid" re-renders; "missing" is upstream's
 *            findActionsVariable arm — a genuine ctx.NotFound(nil)
 *            (variables.go:172-175): answer the app's 404 shell.
 *   POST /{owner}/{repo}/settings/actions/variables/{id}/delete → the path id
 *            + `deleteRepoActionsVariable` (upstream VariableDelete).
 *            "deleted" 303s back; "missing" is the same NotFound arm
 *            (variables.go:186-191).
 *
 * `/{owner}/{repo}` in every URL is the LIVE namespace/slug (repoLink =
 * `/${repo.ownerNamespace}/${repo.slug}` — a renamed repo's next GET renders
 * the new link set).
 *
 * ## Data (§3.5 — the LANDED 0021 store + the secrets-variables service)
 *
 * THE REPO OPS HAVE LANDED — no documented-unrendered arm. The service is
 * scope-generic: `repoScope(repo.id)` IS the repo arm (upstream
 * BelongingScopeRepo's own encoding, models/secret/secret.go:25-33 — the
 * ownerId 0 sentinel over the TEXT repositories.id; owner-scope rows carry
 * `repoId: ''`, so the id spaces are disjoint and cannot collide). Every op
 * this page needs exists and is already served live by the landed repo-scope
 * API family (api/routes/secrets-variables.ts — `/repos/{owner}/{repo}/
 * actions/secrets*` and `.../variables*` all through `repoScope(repo.id)`):
 *
 *   secrets   list `listSecretRows` / write `createOrUpdateSecret` (the
 *             PUT-arm upsert) / delete `deleteSecretByName`;
 *   variables list `listVariableRows` / create `createVariableRow` / update
 *             `updateVariableRow` / delete `deleteVariableRow`.
 *
 * As in the org/user twins: upstream's web list is UNPAGINATED (`db.Find`,
 * shared/secrets/secrets.go:25-28, shared/actions/variables.go:94-96) while
 * the landed service paginates, so the loaders pass a beyond-any-store limit
 * (the *_WEB_LIST_LIMIT constants) — the documented seam. The web routes are
 * ID-keyed while the landed delete/update are NAME-keyed (the API's path-name
 * shape), so the module does the id→row hop inside the repo's scope first — a
 * foreign or stale id answers "missing". The secrets write path applies the
 * EOL normalization module-side (PerformSecretsPost, shared/secrets/
 * secrets.go:42); the variable ops normalize inside the service
 * (InsertVariable / UpdateVariableNameData), so no module-level twin rides
 * there. Validation failures surface the service's exact ApiError texts (the
 * ValidateName trio + "data too long") as the re-rendered error line.
 *
 * ## DOM contract (repo/settings/{layout_head,navbar,actions}.tmpl +
 *  shared/secrets/add_list.tmpl + shared/variables/variable_list.tmpl)
 *
 * layout_head's pageClass is the literal `repository settings actions` for
 * BOTH sub-tabs (actions.tmpl:1). The page is the settings flex-container:
 * repo/settings/navbar.tmpl's `.flex-container-nav` menu with the Actions
 * disclosure OPEN and the active sub-item (navbar.tmpl:41-59 — open when
 * PageIsSharedSettingsSecrets/Variables is set; Secrets :51-53, Variables
 * :54-56, both inside the :47 unit conditional), then
 * `.repo-setting-content` (actions.tmpl:2) with the
 * `h4.ui.top.attached.header` over the `.ui.attached.segment`: the
 * `.flex-divided-list.items-with-main` rows or the none-line, then the add
 * form — field names exactly the shared dialogs' (`name` pattern
 * `^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$` (add_list.tmpl:81,
 * variable_list.tmpl:79), `data` maxlength DataMaxLength, `description`
 * maxlength 4096 rows 2). The secrets row masks the body with `******`; the
 * variables row renders the value IN PLAINTEXT (variable_list.tmpl:31-33).
 *
 * ## Documented reductions (§6 method — never dead controls; the twins' own
 * list, inherited verbatim at the repo URLs)
 *
 * - The `#add-secret-modal` / `#edit-variable-modal` dialogs + `show-modal`
 *   buttons are upstream's JS modal pairs — reduced to the landed twins'
 *   no-JS shape: the ADD form renders inline in the segment; each secrets
 *   row's EDIT renders as a `<details>` disclosure with the READ-ONLY name
 *   and an EMPTY value textarea (the plaintext never enters the DOM,
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
 * - The navbar is the SHARED SettingsNav (settings.tsx — the repo family's
 *   nav home, the wave-settingsnav-fold component) rendered with
 *   `active: "secrets"` / `"variables"` and `hasActions: true` (the route's
 *   MustEnableActions gate already answered the disabled arm); the Actions
 *   disclosure opens while either page renders, and the General / Runners
 *   sub-items render nothing (no landed pages — the dead-link rule; the
 *   shared module's header). Sibling settings pages that do not load the
 *   unit flag render the reduced nav (the conditional Public Access item's
 *   reduction).
 * - The row date renders upstream's `DateUtils.AbsoluteShort` ("Jan 2, 2006")
 *   in UTC (the hand-rolled-clock precedent, the twins' formatActionsDate).
 * - `GET /settings/actions`' general tab (upstream's LocationRedirect onto
 *   the unit + runners-general settings) is unlanded — the URL stays
 *   unclaimed, not rendered, not linked.
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
  repoScope,
  SECRET_DATA_MAX_BYTES,
  updateVariableRow,
  VARIABLE_DATA_MAX_RUNES,
  type SecretRow,
  type VariableRow,
} from "../../api/services/secrets-variables";
import { actionVariables, secrets } from "../../db/schema";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { IconName } from "../icons";
import type { UiContext } from "../ui-context";
import { SettingsNav } from "./settings";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const repoSettingsActionsLocale = {
  actions: "Actions", // "actions.actions" (the secrets page Title, secrets.go:77; the shared navbar carries the disclosure summary)
  secrets_nav: "Secrets", // "secrets.secrets" (the navbar sub-item, navbar.tmpl:51)
  variables_nav: "Variables", // "actions.variables" (the navbar sub-item, navbar.tmpl:55; the variables page Title, variables.go:84)
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
  remove: "Remove", // "remove" (the secrets delete button — the twins' label)
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
export const REPO_ACTIONS_NAME_PATTERN = "^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$";

/** The secrets `data` textarea's maxlength (SecretDataMaxLength —
 *  add_list.tmpl:91's {{.DataMaxLength}}). */
export const REPO_ACTIONS_SECRET_DATA_MAXLENGTH = SECRET_DATA_MAX_BYTES;

/** The variables `data` textarea's maxlength (VariableDataMaxLength —
 *  variable_list.tmpl:89; RUNES upstream, the HTML attribute counts UTF-16
 *  units — the twins' documented reduction). */
export const REPO_ACTIONS_VARIABLE_DATA_MAXLENGTH = VARIABLE_DATA_MAX_RUNES;

/** The `description` textareas' maxlength (SecretDescriptionMaxLength /
 *  VariableDescriptionMaxLength — add_list.tmpl:101, variable_list.tmpl:99). */
export const REPO_ACTIONS_DESCRIPTION_MAXLENGTH = 4096;

/** The loaders' list caps — upstream's web lists are unpaginated (`db.Find`)
 *  while the landed service paginates; a beyond-any-store page size answers
 *  the same rows (the module header; the twins' *_WEB_LIST_LIMIT seam). */
export const REPO_ACTIONS_WEB_LIST_LIMIT = 10000;

// ---------------------------------------------------------------------------
// The secrets write arms (upstream SecretsPost/SecretsDelete over the landed
// service at the REPO scope)
// ---------------------------------------------------------------------------

/** The secrets POST body (the upstream dialog's three fields). */
export interface RepoActionsSecretForm {
  name: string;
  data: string;
  description: string;
}

/** Parse the urlencoded secrets POST (the readUrlEncodedForm convention). */
export function parseRepoActionsSecretForm(params: URLSearchParams): RepoActionsSecretForm {
  return {
    name: params.get("name") ?? "",
    data: params.get("data") ?? "",
    description: params.get("description") ?? "",
  };
}

/** The save outcomes the POST handler renders (the twins' outcome pattern). */
export type SaveRepoActionsSecretOutcome = { outcome: "saved" } | { outcome: "invalid"; message: string };

/** util.NormalizeStringEOL (modules/util/util.go:312) — the WEB write path's
 *  normalization (shared/secrets/secrets.go:42, scope-shared so the repo arm
 *  normalizes too); the landed service mirrors the API path, which does not
 *  normalize, so the module applies it (the twins' shape). */
function normalizeStringEol(input: string): string {
  return input.replaceAll("\r\n", "\n");
}

/**
 * The save — upstream SecretsPost → PerformSecretsPost
 * (shared/secrets/secrets.go:35-56) over the landed `createOrUpdateSecret`
 * at `repoScope(repoId)`: the service validates the name (the ValidateName
 * trio) and length-caps the data, upserting by UPPER(name) — create on a
 * miss, data+description update on a hit (the dialog's edit posts the
 * read-only name back through the same URL). A service ApiError becomes the
 * `invalid` outcome with the exact text; anything else propagates.
 */
export async function applyRepoActionsSecretForm(d1: D1Database, repoId: string, form: RepoActionsSecretForm): Promise<SaveRepoActionsSecretOutcome> {
  try {
    await createOrUpdateSecret(d1, repoScope(repoId), form.name, normalizeStringEol(form.data), form.description);
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
export interface RepoActionsSecretDeleteForm {
  id: number | null;
}

export function parseRepoActionsSecretDeleteForm(params: URLSearchParams): RepoActionsSecretDeleteForm {
  const raw = params.get("id") ?? "";
  return { id: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null };
}

/**
 * The delete — upstream SecretsDelete → PerformSecretsDelete
 * (shared/secrets/secrets.go:58-71): resolve the row within the REPO's scope
 * (upstream's DeleteSecretByID is scope-guarded the same way), then the
 * landed name-keyed `deleteSecretByName`. `"missing"` covers a null id, a
 * foreign id (another repo's or any owner-scope row — user or org; the id
 * spaces are disjoint) and a stale id — every arm 303s back (the
 * idempotent-303 reduction). The scope pair is repoScope's encoding: the
 * ownerId 0 sentinel over the TEXT repositories.id (db/schema.ts).
 */
export async function deleteRepoActionsSecret(d1: D1Database, repoId: string, form: RepoActionsSecretDeleteForm): Promise<"deleted" | "missing"> {
  if (form.id === null) {
    return "missing";
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, form.id), eq(secrets.ownerId, 0), eq(secrets.repoId, repoId)))
      .limit(1)
  )[0];
  if (row === undefined) {
    return "missing";
  }
  const deleted = await deleteSecretByName(d1, repoScope(repoId), row.name);
  return deleted === null ? "missing" : "deleted";
}

// ---------------------------------------------------------------------------
// The variables write arms (upstream VariableCreate/VariableUpdate/
// VariableDelete over the landed service at the REPO scope)
// ---------------------------------------------------------------------------

/** The variable POST body (the upstream dialog's three fields — the shared
 *  EditVariableForm, forms/user_form.go:235-240). */
export interface RepoActionsVariableForm {
  name: string;
  data: string;
  description: string;
}

/** Parse the urlencoded variable POST (the readUrlEncodedForm convention). */
export function parseRepoActionsVariableForm(params: URLSearchParams): RepoActionsVariableForm {
  return {
    name: params.get("name") ?? "",
    data: params.get("data") ?? "",
    description: params.get("description") ?? "",
  };
}

/** The `{variable_id}` path segment (upstream's PathParamInt64): digits only,
 *  junk/absent → null → the `"missing"` arm. */
export function parseRepoActionsVariablePathId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/** The outcomes the variable write handlers render (the twins' outcome
 *  pattern + upstream's findActionsVariable 404 arm). */
export type SaveRepoActionsVariableOutcome =
  | { outcome: "saved" }
  | { outcome: "invalid"; message: string }
  | { outcome: "missing" };

/**
 * The create — upstream VariableCreate → actions_service.CreateVariable
 * (variables.go:107-129) over the landed `createVariableRow` at
 * `repoScope(repoId)`: the service validates the name, rune-counts the
 * value, truncates the description, EOL-normalizes and stores the UPPERCASE
 * name (all inside the service — no module-level normalization, unlike the
 * secrets arm). A service ApiError becomes `invalid` with the exact text;
 * anything else (the UNIQUE duplicate-name db error — upstream has no web
 * pre-check either) propagates.
 */
export async function applyRepoActionsVariableCreate(d1: D1Database, repoId: string, form: RepoActionsVariableForm): Promise<SaveRepoActionsVariableOutcome> {
  try {
    await createVariableRow(d1, repoScope(repoId), form.name, form.data, form.description);
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
 * row by id within the REPO's scope (findActionsVariable's
 * FindVariablesOpts{IDs, BelongingScope} — a miss is the `"missing"`
 * outcome, upstream's ctx.NotFound(nil), variables.go:172-175), then the
 * landed `updateVariableRow` over the row's stored (UPPERCASE) name: the
 * form's name/data/description overwrite all three. An empty form name rides
 * the service's zero-value fallback (keeps the stored name). A service
 * ApiError becomes `invalid`; a resolve-to-update race is `"missing"` like
 * upstream's own re-find arm.
 */
export async function applyRepoActionsVariableUpdate(
  d1: D1Database,
  repoId: string,
  variableId: number | null,
  form: RepoActionsVariableForm,
): Promise<SaveRepoActionsVariableOutcome> {
  if (variableId === null) {
    return { outcome: "missing" };
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(actionVariables)
      .where(and(eq(actionVariables.id, variableId), eq(actionVariables.ownerId, 0), eq(actionVariables.repoId, repoId)))
      .limit(1)
  )[0];
  if (row === undefined) {
    return { outcome: "missing" };
  }
  try {
    const updated = await updateVariableRow(d1, repoScope(repoId), row.name, form.name, form.data, form.description);
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
 * row within the REPO's scope (a foreign, stale or junk id answers
 * `"missing"`, upstream's ctx.NotFound(nil), variables.go:186-191), then the
 * landed name-keyed `deleteVariableRow` on the row's stored name.
 */
export async function deleteRepoActionsVariable(d1: D1Database, repoId: string, variableId: number | null): Promise<"deleted" | "missing"> {
  if (variableId === null) {
    return "missing";
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(actionVariables)
      .where(and(eq(actionVariables.id, variableId), eq(actionVariables.ownerId, 0), eq(actionVariables.repoId, repoId)))
      .limit(1)
  )[0];
  if (row === undefined) {
    return "missing";
  }
  const deleted = await deleteVariableRow(d1, repoScope(repoId), row.name);
  return deleted === null ? "missing" : "deleted";
}

// ---------------------------------------------------------------------------
// The list loaders (upstream SetSecretsContext / Variables' Find —
// shared/secrets/secrets.go:24-33, shared/actions/variables.go:94-96)
// ---------------------------------------------------------------------------

/** The secrets sub-tab's render inputs. `form` re-renders the submitted
 *  add/edit values (the empty triple on the plain GET). */
export interface RepoActionsSecretsPageData {
  secrets: SecretRow[];
  form: RepoActionsSecretForm;
}

/** The secrets page load — the repo's scope rows, name-ordered (the
 *  service's FindSecretsOptions order). */
export async function loadRepoActionsSecretsPageData(d1: D1Database, repoId: string): Promise<RepoActionsSecretsPageData> {
  const { rows } = await listSecretRows(d1, repoScope(repoId), 1, REPO_ACTIONS_WEB_LIST_LIMIT);
  return { secrets: rows, form: { name: "", data: "", description: "" } };
}

/** The variables sub-tab's render inputs. `form` re-renders the submitted add
 *  values (the empty triple on the plain GET). */
export interface RepoActionsVariablesPageData {
  variables: VariableRow[];
  form: RepoActionsVariableForm;
}

/** The variables page load — the repo's scope rows, name-ordered. */
export async function loadRepoActionsVariablesPageData(d1: D1Database, repoId: string): Promise<RepoActionsVariablesPageData> {
  const { rows } = await listVariableRows(d1, repoScope(repoId), 1, REPO_ACTIONS_WEB_LIST_LIMIT);
  return { variables: rows, form: { name: "", data: "", description: "" } };
}

// ---------------------------------------------------------------------------
// The render (repo/settings/actions.tmpl PageType "secrets"/"variables" +
//  shared/secrets/add_list.tmpl + shared/variables/variable_list.tmpl)
// ---------------------------------------------------------------------------

/** Upstream `DateUtils.AbsoluteShort` ("Jan 2, 2006") — UTC, hand-rolled so
 *  the bytes never depend on the runtime's ICU (the twins'
 *  formatSecretDate/formatActionsDate precedent). */
export function formatRepoActionsDate(date: Date): string {
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
        <label for={`${props.idPrefix}-name`}>{repoSettingsActionsLocale.name}</label>
        <input
          autofocus={props.readOnlyName ? undefined : true}
          required
          id={`${props.idPrefix}-name`}
          name="name"
          value={props.form.name}
          pattern={props.readOnlyName ? undefined : REPO_ACTIONS_NAME_PATTERN}
          title={repoSettingsActionsLocale.name_pattern}
          placeholder={props.readOnlyName ? undefined : props.namePlaceholder}
          readOnly={props.readOnlyName ? true : undefined}
        />
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-data`}>{repoSettingsActionsLocale.value}</label>
        <textarea
          required
          id={`${props.idPrefix}-data`}
          name="data"
          maxlength={props.dataMaxlength}
          placeholder={repoSettingsActionsLocale.value_placeholder}
        >
          {props.readOnlyName ? "" : props.form.data}
        </textarea>
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-description`}>{repoSettingsActionsLocale.description_label}</label>
        <textarea
          id={`${props.idPrefix}-description`}
          name="description"
          rows={2}
          maxlength={REPO_ACTIONS_DESCRIPTION_MAXLENGTH}
          placeholder={repoSettingsActionsLocale.description_placeholder}
        >
          {props.readOnlyName ? "" : props.form.description}
        </textarea>
      </div>
    </>
  );
}

/** One add_list.tmpl row (add_list.tmpl:21-59) at the REPO URLs: the key
 *  glyph, the name/description/****** body, the Added-on stamp, the edit
 *  disclosure (the modal reduction — read-only name, empty value) and the
 *  remove form (the hidden-id POST to .../secrets/delete). */
export function RepoActionsSecretRowItem(props: { repoLink: string; row: SecretRow }) {
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
          {repoSettingsActionsLocale.added_on} {formatRepoActionsDate(row.createdAt)}
        </span>
        <details>
          <summary class="flex-text-inline">
            <Icon name="octicon-pencil" /> {repoSettingsActionsLocale.edit_secret}
          </summary>
          {/* The modal's form (add_list.tmpl:71 — data-modal-form.url
              {{$.Link}}): the list URL, read-only name, empty value. */}
          <form class="ui form" action={`${props.repoLink}/settings/actions/secrets`} method="post">
            <ActionsFormFields
              idPrefix={`secret-edit-${row.id}`}
              form={{ name: row.name, data: "", description: "" }}
              readOnlyName={true}
              dataMaxlength={REPO_ACTIONS_SECRET_DATA_MAXLENGTH}
              namePlaceholder="MY_SECRET_NAME"
            />
            <div class="field">
              <button type="submit" class="ui primary button">
                {repoSettingsActionsLocale.edit_secret}
              </button>
            </div>
          </form>
        </details>
        <form class="tw-inline-block" action={`${props.repoLink}/settings/actions/secrets/delete`} method="post">
          <input type="hidden" name="id" value={String(row.id)} />
          <button type="submit" class="ui red tiny button">
            {repoSettingsActionsLocale.remove}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The row's leading glyph. Upstream renders `{{svg "octicon-key" 32}}`
 *  (add_list.tmpl:23); octicon-key is outside the generated icon allowlist —
 *  octicon-shield-lock is the documented stand-in (the keys sibling's
 *  KEY_ICON convention, the twins' SECRET_ICON). */
const SECRET_ICON: IconName = "octicon-shield-lock";

/** One variable_list.tmpl row (variable_list.tmpl:20-58) at the REPO URLs:
 *  the pencil glyph, the name/description/value body — the value renders IN
 *  PLAINTEXT (variable_list.tmpl:31-33; variables are not masked) — the
 *  Added-on stamp, the edit disclosure (all three fields pre-filled,
 *  variable_list.tmpl:44-46) posting to the row's own /{id}/edit URL, and
 *  the remove form (the id in the path, no hidden field). */
export function RepoActionsVariableRowItem(props: { repoLink: string; row: VariableRow }) {
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
          {repoSettingsActionsLocale.added_on} {formatRepoActionsDate(row.createdAt)}
        </span>
        <details>
          <summary class="flex-text-inline">
            <Icon name="octicon-pencil" /> {repoSettingsActionsLocale.edit_variable}
          </summary>
          {/* The dialog's form (variable_list.tmpl:69) targeting the row's
              own URL ({{$.Link}}/{{.ID}}/edit, :42), pre-filled from the row
              (:44-46). */}
          <form class="ui form" action={`${props.repoLink}/settings/actions/variables/${row.id}/edit`} method="post">
            <ActionsFormFields
              idPrefix={`variable-edit-${row.id}`}
              form={{ name: row.name, data: row.data, description: row.description }}
              readOnlyName={false}
              dataMaxlength={REPO_ACTIONS_VARIABLE_DATA_MAXLENGTH}
              namePlaceholder="MY_VARIABLE_NAME"
            />
            <div class="field">
              <button type="submit" class="ui primary button">
                {repoSettingsActionsLocale.edit_variable}
              </button>
            </div>
          </form>
        </details>
        <form class="tw-inline-block" action={`${props.repoLink}/settings/actions/variables/${row.id}/delete`} method="post">
          <button type="submit" class="ui red tiny button">
            <Icon name="octicon-trash" /> {repoSettingsActionsLocale.deletion}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The full-document renders (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component).
 *  `error` carries the failed POST's message (null on the plain GET). */
export function renderRepoActionsSecretsPage(ctx: UiContext, data: RepoActionsSecretsPageData, error: string | null = null): string {
  return renderPage(<RepoActionsSecretsPage ctx={ctx} data={data} error={error} />);
}

export function renderRepoActionsVariablesPage(ctx: UiContext, data: RepoActionsVariablesPageData, error: string | null = null): string {
  return renderPage(<RepoActionsVariablesPage ctx={ctx} data={data} error={error} />);
}

/** The secrets page (§2.4.1 discriminator: `repository settings actions` —
 *  layout_head's pageClass dict, actions.tmpl:1; upstream's Title is
 *  `actions.actions`, secrets.go:77). The settings pages' ctx.repo contract
 *  (the LFS shell's throw). */
export function RepoActionsSecretsPage(props: { ctx: UiContext; data: RepoActionsSecretsPageData; error: string | null }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoActionsSecretsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={repoSettingsActionsLocale.actions} pageClass="repository settings actions">
      <div class="ui container flex-container">
        {/* hasActions: true — the route's MustEnableActions gate already
            answered the disabled unit's 404 (the module header); the
            conditional renders the Actions disclosure with the landed
            sub-items only. */}
        <SettingsNav repoLink={repoLink} active="secrets" repo={repo} hasActions={true} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            {/* shared/secrets/add_list.tmpl:1-16 */}
            <h4 class="ui top attached header">{repoSettingsActionsLocale.secrets_management}</h4>
            <div class="ui attached segment">
              {props.data.secrets.length > 0 ? (
                <div class="flex-divided-list items-with-main">
                  {props.data.secrets.map((row) => (
                    <RepoActionsSecretRowItem key={row.id} repoLink={repoLink} row={row} />
                  ))}
                </div>
              ) : (
                <p>{repoSettingsActionsLocale.secrets_none}</p>
              )}
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {/* The add-secret dialog reduced to the inline form (the
                  module header) — the dialog's lead line rides above it
                  (add_list.tmpl:74). */}
              <div class="tw-mt-4" id="add-secret-panel">
                <p>{repoSettingsActionsLocale.secrets_description}</p>
                <form class="ui form" action={`${repoLink}/settings/actions/secrets`} method="post">
                  <ActionsFormFields
                    idPrefix="secret-add"
                    form={props.data.form}
                    readOnlyName={false}
                    dataMaxlength={REPO_ACTIONS_SECRET_DATA_MAXLENGTH}
                    namePlaceholder="MY_SECRET_NAME"
                  />
                  <div class="field">
                    <button type="submit" class="ui primary button">
                      {repoSettingsActionsLocale.add_secret}
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

/** The variables page (§2.4.1 discriminator: `repository settings actions` —
 *  actions.tmpl:1; upstream's Title is `actions.variables`,
 *  variables.go:84). */
export function RepoActionsVariablesPage(props: { ctx: UiContext; data: RepoActionsVariablesPageData; error: string | null }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoActionsVariablesPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={repoSettingsActionsLocale.variables_nav} pageClass="repository settings actions">
      <div class="ui container flex-container">
        {/* hasActions: true — see the secrets page's note. */}
        <SettingsNav repoLink={repoLink} active="variables" repo={repo} hasActions={true} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            {/* shared/variables/variable_list.tmpl:1-64 */}
            <h4 class="ui top attached header">{repoSettingsActionsLocale.variables_management}</h4>
            <div class="ui attached segment">
              {props.data.variables.length > 0 ? (
                <div class="flex-divided-list items-with-main">
                  {props.data.variables.map((row) => (
                    <RepoActionsVariableRowItem key={row.id} repoLink={repoLink} row={row} />
                  ))}
                </div>
              ) : (
                <p>{repoSettingsActionsLocale.variables_none}</p>
              )}
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {/* The #edit-variable-modal dialog reduced to the inline add
                  form (the module header) — the dialog's lead line rides
                  above it (variable_list.tmpl:72). */}
              <div class="tw-mt-4" id="add-variable-panel">
                <p>{repoSettingsActionsLocale.variables_description}</p>
                <form class="ui form" action={`${repoLink}/settings/actions/variables/new`} method="post">
                  <ActionsFormFields
                    idPrefix="variable-add"
                    form={props.data.form}
                    readOnlyName={false}
                    dataMaxlength={REPO_ACTIONS_VARIABLE_DATA_MAXLENGTH}
                    namePlaceholder="MY_VARIABLE_NAME"
                  />
                  <div class="field">
                    <button type="submit" class="ui primary button">
                      {repoSettingsActionsLocale.add_variable}
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
