/**
 * The ADMIN actions VARIABLES page — `/-/admin/actions/variables` — the
 * ui-parity survey tick-19's admin-scope variables arm (the ADMIN scope of
 * the shared variables builders, ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef; the repo twin is
 * pages/repo-settings-actions-secrets-variables.tsx's variables arm, the
 * org/user twins are org-settings-actions.tsx / user-settings-variables.tsx).
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - `routers/web/web.go:898-904` — the admin `/-/admin/actions` group's
 *     `addSettingsVariablesRoutes()` (:902 — web.go:489-496's shared group:
 *     `GET ""` Variables, `POST /new` VariableCreate,
 *     `POST /{variable_id}/edit` VariableUpdate,
 *     `POST /{variable_id}/delete` VariableDelete) inside the group closed
 *     behind `adminReq` (the shared adminPagePrologue's exact posture).
 *   - `routers/web/shared/actions/variables.go` — the ADMIN arm of
 *     `getVariablesCtx` (:71-78 — BelongingScopeGlobal() =
 *     `{OwnerID: 0, RepoID: 0}`, IsGlobal, tplAdminVariables
 *     "admin/actions", RedirectLink AppSubURL + "/-/admin/actions/variables");
 *     `Variables` (:83-105 — the unpaginated Find), `VariableCreate`
 *     (:107-129), `VariableUpdate` (:131-161 — findActionsVariable's
 *     scope-pinned resolve then the three-field overwrite), `VariableDelete`
 *     (:179-200), `findActionsVariable` (:163-177 — IDs + BelongingScope; a
 *     miss is the ctx.NotFound(nil) arm).
 *   - Templates: `admin/actions.tmpl` (layout_head pageClass
 *     `admin actions`; the PageType "variables" arm renders
 *     shared/variables/variable_list.tmpl into `.admin-setting-content`).
 *     The variable_list contract is scope-shared — the plaintext value body,
 *     the added-on stamp, the one-dialog edit (name + data + description
 *     pre-filled), the row's `/{id}/edit` and `/{id}/delete` targets, the
 *     `new` add target (variable_list.tmpl:6, 41, 51).
 *
 * ## Mount record (PRE-MOUNT — the routes 404 through the router until the
 * orchestrator executes the HANDOFF recipes; the tests pin the parse nulls)
 *
 *   GET  /-/admin/actions/variables                 → list
 *   POST /-/admin/actions/variables/new             → create
 *   POST /-/admin/actions/variables/{id}/edit       → update
 *   POST /-/admin/actions/variables/{id}/delete     → delete
 *
 * all behind the shared adminPagePrologue, the POSTs sameOriginGuard-first
 * (the family convention).
 *
 * ## Data (§3.5 — the LANDED 0021 store + the secrets-variables service, at
 * the GLOBAL scope)
 *
 * The service is scope-generic; the GLOBAL arm is the scope pair `{ownerId:
 * 0, repoId: ""}` — upstream BelongingScopeGlobal's own encoding (the
 * dispatch service reads the same pair for the global variables tier,
 * services/actions/dispatch.ts:518-519). Every op exists:
 * `listVariableRows` / `createVariableRow` / `updateVariableRow` /
 * `deleteVariableRow`. As in the twins: upstream's web list is UNPAGINATED
 * (`db.Find`, variables.go:94-96) while the service paginates, so the loader
 * passes a beyond-any-store limit (the twins' *_WEB_LIST_LIMIT seam). The
 * web routes are ID-keyed while the landed update/delete are NAME-keyed, so
 * the module does the id→row hop inside the global scope first — a foreign
 * or stale id (any repo/owner-scope row) answers "missing". The variable ops
 * normalize inside the service (InsertVariable / UpdateVariableNameData), so
 * no module-level twin rides. Validation failures surface the service's
 * exact ApiError texts as the re-rendered error line.
 *
 * ## Documented reductions (§6 method — the twins' list, inherited verbatim
 * at the admin URLs)
 *
 * - The `#edit-variable-modal` dialog + `show-modal` button reduce to the
 *   twins' no-JS shape: the ADD form renders inline in the segment; each
 *   row's EDIT renders as a `<details>` disclosure pre-filling all three
 *   fields, posting to the row's own `/{id}/edit` URL; the remove buttons
 *   are plain form POSTs (upstream's link-action + data-modal-confirm pairs
 *   are not reproduced).
 * - The 303 targets: every success 303s back onto the list URL (upstream's
 *   JSONRedirect(RedirectLink) — the no-session-flash reduction, the twins'
 *   convention); "invalid" re-renders with the error line + the submitted
 *   values (upstream's JSONErrorAuto is a form-fetch-action JS arm); a
 *   "missing" id is upstream's genuine ctx.NotFound(nil)
 *   (variables.go:172-175 / :186-191) — the app's 404 shell.
 * - The navbar is the module-local AdminActionsNav imported from the runners
 *   module (one copy for the wave — the module header's nav note); the
 *   HANDOFF's step 6 folds both onto AdminFamilyShell.
 * - Scoped Workflows (web.go:903's group arm) is NOT SERVED — the runners
 *   module's reduction verdict carries for the whole group.
 *
 * ## HANDOFF (the ui/index.ts mount — the orchestrator window's arms)
 *
 * 1. Families (the admin family union):
 *
 *     | "admin-actions-variables" // GET /-/admin/actions/variables
 *     | "admin-actions-variables-new" // POST .../variables/new
 *     | "admin-actions-variables-edit" // POST .../variables/{id}/edit
 *     | "admin-actions-variables-delete" // POST .../variables/{id}/delete
 *
 * 2. Parse arms (inside the admin block):
 *
 *     if (tail.length === 3 && tail[0] === "actions" && tail[1] === "variables" && tail[2] === "new")
 *       return { family: "admin-actions-variables-new" };
 *     if (tail.length === 4 && tail[0] === "actions" && tail[1] === "variables" && /^\d+$/.test(tail[2]) && tail[3] === "edit")
 *       return { family: "admin-actions-variables-edit", id: Number.parseInt(tail[2], 10) };
 *     if (tail.length === 4 && tail[0] === "actions" && tail[1] === "variables" && /^\d+$/.test(tail[2]) && tail[3] === "delete")
 *       return { family: "admin-actions-variables-delete", id: Number.parseInt(tail[2], 10) };
 *     if (tail.length === 2 && tail[0] === "actions" && tail[1] === "variables")
 *       return { family: "admin-actions-variables" };
 *
 * 3. Import:
 *
 *     import {
 *       applyAdminActionsVariableCreate,
 *       applyAdminActionsVariableUpdate,
 *       deleteAdminActionsVariable,
 *       loadAdminActionsVariablesPageData,
 *       parseAdminActionsVariableForm,
 *       parseAdminActionsVariablePathId,
 *       renderAdminActionsVariablesPage,
 *     } from "./pages/admin-actions-variables";
 *
 * 4. Handlers (the family prologue; writes sameOriginGuard-first; the list
 *    URL constant is "/-/admin/actions/variables"):
 *
 *     async function adminActionsVariablesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const data = await loadAdminActionsVariablesPageData(c.env.DB);
 *       return p.respond(c.html(renderAdminActionsVariablesPage(p.ctx, data), 200));
 *     }
 *
 *     async function adminActionsVariableCreate(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const form = parseAdminActionsVariableForm(await readUrlEncodedForm(c.req.raw));
 *       const outcome = await applyAdminActionsVariableCreate(c.env.DB, form);
 *       if (outcome.outcome === "saved") {
 *         return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/variables" } }));
 *       }
 *       const data = await loadAdminActionsVariablesPageData(c.env.DB);
 *       return p.respond(c.html(renderAdminActionsVariablesPage(p.ctx, data, outcome.message), 200));
 *     }
 *
 *     async function adminActionsVariableEdit(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const form = parseAdminActionsVariableForm(await readUrlEncodedForm(c.req.raw));
 *       const outcome = await applyAdminActionsVariableUpdate(c.env.DB, variableId, form);
 *       if (outcome.outcome === "saved") {
 *         return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/variables" } }));
 *       }
 *       if (outcome.outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       const data = await loadAdminActionsVariablesPageData(c.env.DB);
 *       return p.respond(c.html(renderAdminActionsVariablesPage(p.ctx, data, outcome.message), 200));
 *     }
 *
 *     async function adminActionsVariableDelete(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const outcome = await deleteAdminActionsVariable(c.env.DB, variableId);
 *       if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/variables" } }));
 *     }
 *
 * 5. Registrations (the static block, beside the runners lines):
 *
 *     uiRouter.get("/-/admin/actions/variables", (c) => adminActionsVariablesPage(c));
 *     uiRouter.post("/-/admin/actions/variables/new", (c) => adminActionsVariableCreate(c));
 *     uiRouter.post("/-/admin/actions/variables/:id{\\d+}/edit", (c) => adminActionsVariableEdit(c, Number.parseInt(c.req.param("id"), 10)));
 *     uiRouter.post("/-/admin/actions/variables/:id{\\d+}/delete", (c) => adminActionsVariableDelete(c, Number.parseInt(c.req.param("id"), 10)));
 *     uiRouter.get("/-/admin/actions/variables/new", () => methodNotAllowed("POST"));
 *     uiRouter.get("/-/admin/actions/variables/:id{\\d+}/edit", () => methodNotAllowed("POST"));
 *     uiRouter.get("/-/admin/actions/variables/:id{\\d+}/delete", () => methodNotAllowed("POST"));
 *
 * 6. The shared-nav extension: the runners module's HANDOFF step 6 covers
 *    this module too (the swap onto AdminFamilyShell with
 *    active="actions-variables").
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  createVariableRow,
  deleteVariableRow,
  listVariableRows,
  updateVariableRow,
  type VariableRow,
} from "../../api/services/secrets-variables";
import { actionVariables } from "../../db/schema";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import {
  formatRepoActionsDate,
  REPO_ACTIONS_DESCRIPTION_MAXLENGTH,
  REPO_ACTIONS_NAME_PATTERN,
  REPO_ACTIONS_VARIABLE_DATA_MAXLENGTH,
  REPO_ACTIONS_WEB_LIST_LIMIT,
  repoSettingsActionsLocale,
} from "./repo-settings-actions-secrets-variables";
import { AdminActionsNav } from "./admin-actions-runners";

// ---------------------------------------------------------------------------
// The GLOBAL scope (upstream BelongingScopeGlobal() — variables.go:71-78's
// {OwnerID: 0, RepoID: 0}; the service's scope-pair encoding, the same pair
// the dispatch service reads for the global tier)
// ---------------------------------------------------------------------------

/** The scope pair the landed service takes (SecretScope's fields). */
const GLOBAL_SCOPE = { ownerId: 0, repoId: "" };

// ---------------------------------------------------------------------------
// The list loader (Variables, variables.go:83-105 — the unpaginated Find at
// the global scope)
// ---------------------------------------------------------------------------

/** The variables sub-tab's render inputs. `form` re-renders the submitted add
 *  values (the empty triple on the plain GET). */
export interface AdminActionsVariablesPageData {
  variables: VariableRow[];
  form: AdminActionsVariableForm;
}

/** The variables page load — the GLOBAL scope's rows only, name-ordered
 *  (the service's FindVariablesOptions order). */
export async function loadAdminActionsVariablesPageData(d1: D1Database): Promise<AdminActionsVariablesPageData> {
  const { rows } = await listVariableRows(d1, GLOBAL_SCOPE, 1, REPO_ACTIONS_WEB_LIST_LIMIT);
  return { variables: rows, form: { name: "", data: "", description: "" } };
}

// ---------------------------------------------------------------------------
// The write arms (upstream VariableCreate/VariableUpdate/VariableDelete over
// the landed service at the GLOBAL scope — the repo twin's shape, scope
// swapped)
// ---------------------------------------------------------------------------

/** The variable POST body (the upstream dialog's three fields — the shared
 *  EditVariableForm, forms/user_form.go:235-240). */
export interface AdminActionsVariableForm {
  name: string;
  data: string;
  description: string;
}

/** Parse the urlencoded variable POST (the readUrlEncodedForm convention). */
export function parseAdminActionsVariableForm(params: URLSearchParams): AdminActionsVariableForm {
  return {
    name: params.get("name") ?? "",
    data: params.get("data") ?? "",
    description: params.get("description") ?? "",
  };
}

/** The `{variable_id}` path segment (upstream's PathParamInt64): digits only,
 *  junk/absent → null → the `"missing"` arm. */
export function parseAdminActionsVariablePathId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/** The outcomes the variable write handlers render (the twins' outcome
 *  pattern + upstream's findActionsVariable 404 arm). */
export type SaveAdminActionsVariableOutcome =
  | { outcome: "saved" }
  | { outcome: "invalid"; message: string }
  | { outcome: "missing" };

/**
 * The create — upstream VariableCreate → actions_service.CreateVariable
 * (variables.go:107-129) over the landed `createVariableRow` at the GLOBAL
 * scope: the service validates the name, rune-counts the value, truncates
 * the description, EOL-normalizes and stores the UPPERCASE name (all inside
 * the service). A service ApiError becomes `invalid` with the exact text;
 * anything else (the UNIQUE duplicate-name db error — upstream has no web
 * pre-check either) propagates.
 */
export async function applyAdminActionsVariableCreate(d1: D1Database, form: AdminActionsVariableForm): Promise<SaveAdminActionsVariableOutcome> {
  try {
    await createVariableRow(d1, GLOBAL_SCOPE, form.name, form.data, form.description);
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
 * row by id within the GLOBAL scope (findActionsVariable's
 * FindVariablesOpts{IDs, BelongingScope} — a foreign/stale/junk id is the
 * `"missing"` outcome, upstream's ctx.NotFound(nil), variables.go:172-175),
 * then the landed `updateVariableRow` over the row's stored (UPPERCASE)
 * name: the form's name/data/description overwrite all three. An empty form
 * name rides the service's zero-value fallback (keeps the stored name).
 */
export async function applyAdminActionsVariableUpdate(
  d1: D1Database,
  variableId: number | null,
  form: AdminActionsVariableForm,
): Promise<SaveAdminActionsVariableOutcome> {
  if (variableId === null) {
    return { outcome: "missing" };
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(actionVariables)
      .where(and(eq(actionVariables.id, variableId), eq(actionVariables.ownerId, 0), eq(actionVariables.repoId, "")))
      .limit(1)
  )[0];
  if (row === undefined) {
    return { outcome: "missing" };
  }
  try {
    const updated = await updateVariableRow(d1, GLOBAL_SCOPE, row.name, form.name, form.data, form.description);
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
 * row within the GLOBAL scope (a foreign — repo/owner-scope — stale or junk
 * id answers `"missing"`, upstream's ctx.NotFound(nil),
 * variables.go:186-191), then the landed name-keyed `deleteVariableRow` on
 * the row's stored name.
 */
export async function deleteAdminActionsVariable(d1: D1Database, variableId: number | null): Promise<"deleted" | "missing"> {
  if (variableId === null) {
    return "missing";
  }
  const row = (
    await drizzle(d1)
      .select()
      .from(actionVariables)
      .where(and(eq(actionVariables.id, variableId), eq(actionVariables.ownerId, 0), eq(actionVariables.repoId, "")))
      .limit(1)
  )[0];
  if (row === undefined) {
    return "missing";
  }
  const deleted = await deleteVariableRow(d1, GLOBAL_SCOPE, row.name);
  return deleted === null ? "missing" : "deleted";
}

// ---------------------------------------------------------------------------
// The render — admin/actions.tmpl PageType "variables" over
// shared/variables/variable_list.tmpl
// ---------------------------------------------------------------------------

/** The dialogs' `name` input pattern attribute, verbatim
 *  (variable_list.tmpl:79) — the client-side mirror of ValidateName. */
export const ADMIN_ACTIONS_NAME_PATTERN = REPO_ACTIONS_NAME_PATTERN;

/** The shared name/value/description fields (the upstream dialog's three
 *  field divs, variable_list.tmpl:74-102 — the repo twin's ActionsFormFields
 *  shape re-issued at the admin module: that component is module-private and
 *  its file is outside this wave's ownership). */
function ActionsFormFields(props: {
  idPrefix: string;
  form: { name: string; data: string; description: string };
}) {
  return (
    <>
      <div class="field">
        <label for={`${props.idPrefix}-name`}>{repoSettingsActionsLocale.name}</label>
        <input
          autofocus
          required
          id={`${props.idPrefix}-name`}
          name="name"
          value={props.form.name}
          pattern={ADMIN_ACTIONS_NAME_PATTERN}
          title={repoSettingsActionsLocale.name_pattern}
          placeholder="MY_VARIABLE_NAME"
        />
      </div>
      <div class="field">
        <label for={`${props.idPrefix}-data`}>{repoSettingsActionsLocale.value}</label>
        <textarea required id={`${props.idPrefix}-data`} name="data" maxlength={REPO_ACTIONS_VARIABLE_DATA_MAXLENGTH} placeholder={repoSettingsActionsLocale.value_placeholder}>
          {props.form.data}
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
          {props.form.description}
        </textarea>
      </div>
    </>
  );
}

/** The date stamp — the repo twin's shared formatter (the twins'
 *  formatActionsDate; upstream DateUtils.AbsoluteShort in UTC). */
export const formatAdminActionsDate = formatRepoActionsDate;

/** One variable_list.tmpl row (variable_list.tmpl:20-58) at the ADMIN URLs:
 *  the pencil glyph, the name/description/value body — the value renders IN
 *  PLAINTEXT (variable_list.tmpl:31-33; variables are not masked) — the
 *  Added-on stamp, the edit disclosure (all three fields pre-filled,
 *  variable_list.tmpl:44-46) posting to the row's own /{id}/edit URL, and
 *  the remove form (the id in the path, no hidden field). */
export function AdminActionsVariableRowItem(props: { row: VariableRow }) {
  const { row } = props;
  const base = "/-/admin/actions/variables";
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
          {repoSettingsActionsLocale.added_on} {formatAdminActionsDate(row.createdAt)}
        </span>
        <details>
          <summary class="flex-text-inline">
            <Icon name="octicon-pencil" /> {repoSettingsActionsLocale.edit_variable}
          </summary>
          {/* The dialog's form (variable_list.tmpl:69) targeting the row's
              own URL ({{$.Link}}/{{.ID}}/edit, :42), pre-filled from the row
              (:44-46). */}
          <form class="ui form" action={`${base}/${row.id}/edit`} method="post">
            <ActionsFormFields idPrefix={`variable-edit-${row.id}`} form={{ name: row.name, data: row.data, description: row.description }} />
            <div class="field">
              <button type="submit" class="ui primary button">
                {repoSettingsActionsLocale.edit_variable}
              </button>
            </div>
          </form>
        </details>
        <form class="tw-inline-block" action={`${base}/${row.id}/delete`} method="post">
          <button type="submit" class="ui red tiny button">
            <Icon name="octicon-trash" /> {repoSettingsActionsLocale.deletion}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed POST's message (null on the plain GET). */
export function renderAdminActionsVariablesPage(ctx: UiContext, data: AdminActionsVariablesPageData, error: string | null = null): string {
  return renderPage(<AdminActionsVariablesPage ctx={ctx} data={data} error={error} />);
}

/** The variables page (§2.4.1 discriminator: `admin actions` —
 *  admin/actions.tmpl's layout_head dict; upstream's Title is
 *  `actions.variables`, variables.go:84). */
export function AdminActionsVariablesPage(props: { ctx: UiContext; data: AdminActionsVariablesPageData; error: string | null }) {
  const { ctx } = props;
  const base = "/-/admin/actions/variables";
  return (
    <BaseLayout ctx={ctx} title={repoSettingsActionsLocale.variables_nav} pageClass="admin actions">
      <div class="ui container fluid padded flex-container">
        <AdminActionsNav active="actions-variables" />
        <div class="flex-container-main">
          <div class="admin-setting-content">
            {/* shared/variables/variable_list.tmpl:1-17 */}
            <h4 class="ui top attached header">{repoSettingsActionsLocale.variables_management}</h4>
            <div class="ui attached segment">
              {props.data.variables.length > 0 ? (
                <div class="flex-divided-list items-with-main">
                  {props.data.variables.map((row) => (
                    <AdminActionsVariableRowItem key={row.id} row={row} />
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
                <form class="ui form" action={`${base}/new`} method="post">
                  <ActionsFormFields idPrefix="variable-add" form={props.data.form} />
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
