/**
 * The org labels management page — pages wave 14 (SPEC-0008 U3 extension):
 * the label list (`/{org}/labels`), the create form, and the per-row edit +
 * delete writes, all over the landed org-label service family
 * (src/api/services/labels-t2.ts — the orgLabel API family orgListLabels /
 * orgCreateLabel / orgGetLabel / orgEditLabel / orgDeleteLabel, routes/
 * labels-t2.ts). THE org-owner family, exactly the org-teams posture
 * (pages/org-teams.tsx): every route answers the landed `requireOrgOwnership`
 * gate collapsed to the settings pages' shape — anonymous 303s onto the login
 * round-trip, a signed-in non-owner 404-shells (the upstream management page
 * sits inside the "require owner permission" org group, web.go:1015-1093).
 *
 * ## DOM contract (templates/org/settings/labels.tmpl +
 *  repo/issue/labels/label_list.tmpl + label_edit_modal.tmpl at the pin)
 *
 * `.page-content.organization settings labels`, then the shared pages/
 * org-home.tsx OrgHeader, then the container (the org-teams pages' shape —
 * upstream's org-settings layout_head renders a settings navbar whose other
 * items are pages this slice does not have; the dead-link rule drops the
 * navbar entirely). The prompt row carries org.settings.labels_desc (the
 * `<strong>` pair inline), the create form is label_edit_modal.tmpl's form
 * reduced to the brief's two fields (title + color — the create arm's
 * required pair), and the list is label_list.tmpl's `.issue-label-list`
 * rows: the RenderLabel badge (the wave-2 port — issues-list.tsx's
 * LabelBadge with ContrastColor), the description line, the open-issues
 * count, and the edit/delete controls.
 *
 * ## Route shapes (upstream divergences, §6 method)
 *
 * - The URL is the wave brief's literal `/{org}/labels`; upstream mounts the
 *   management page at `/{org}/settings/labels` under the `/org` prefix
 *   (web.go:1043-1048) — the literal claims the second segment before the
 *   repo parse could read it as a repository named "labels" (the teams
 *   precedent), which upstream's nested route does not shadow: the
 *   documented divergence, wave-12's teams posture.
 * - The writes POST to `/labels/new`, `/labels/edit`, `/labels/delete` —
 *   upstream's exact POST segments. The form field names are upstream's
 *   CreateLabelForm (`title`, `color`, hidden `id`).
 * - The per-row edit is upstream's JS modal (label_edit_modal.tmpl) reduced
 *   to a no-JS `<details>` disclosure per row carrying the same two fields;
 *   the modal's exclusive/exclusive_order/is_archived/description fields are
 *   not rendered (the brief's fields only — the landed PATCH arm keeps each
 *   of them when the form does not send it).
 * - `/labels/initialize` (the upstream label-template loader) stays
 *   unclaimed → the engine's 404: no landed template catalog.
 *
 * ## Write paths (§3.2 — the landed services, never a self-fetch)
 *
 * - Create: `normalizeLabelColor` (the create arm's normalization, the 422
 *   message surfaced inline) + `createOrgLabel` — the arm's is_archived
 *   quirk (org.CreateLabel never stamps archived) rides along.
 * - Edit: `findOrgLabelById` (org-scoped — another org's id 404-shells, the
 *   landed PATCH arm's plain "not found") + `editRepoLabel` (the shared
 *   label primitive the PATCH arm calls directly).
 * - Delete: `findOrgLabelById` + `deleteRepoLabel` (the cascade arm);
 *   a missing label deletes zero rows and still succeeds — the landed
 *   DELETE arm's 204 semantics answered as a 303 back onto the list, so a
 *   repeated (or raced) delete is idempotent and nothing about foreign ids
 *   leaks (the re-render never shows them).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The sort dropdown (label_list.tmpl's `?sort=` menu) is not rendered: the
 *   upstream control is a JS dropdown. The silent `?sort=` query is still
 *   honored exactly like the landed list arm (never declared upstream —
 *   routes/labels-t2.ts's sortParam), unknown values taking the default
 *   alphabetical order.
 * - The per-row open-issues count renders as text: upstream links it onto
 *   the `/issues?labels={id}` dashboard facet, a page this slice does not
 *   have (the dead-link rule).
 * - The list caps at one page of 50 with no pager (the settings hooks list's
 *   cap pattern — upstream RetrieveLabels lists unbounded). The header count
 *   carries the pagination-independent total.
 * - A failed per-row edit re-renders with the error banner and the STORED
 *   row values (the rows are list-rendered; only the create form is
 *   submission-bound). The only edit failure the arm can produce is the
 *   color 422, and the banner names it.
 */

import { ApiError } from "../../api/errors";
import {
  createOrgLabel,
  findOrgLabelById,
  listOrgLabels,
} from "../../api/services/labels-t2";
import {
  deleteRepoLabel,
  editRepoLabel,
  normalizeLabelColor,
  type LabelSortType,
} from "../../api/services/labels";
import type { LabelRow } from "../../issues/service";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { LabelBadge, contrastColor } from "./issues-list";
import { OrgHeader } from "./org-home";
import type { OrgRecord } from "../../services/orgs/orgs";

/** Page chrome text (component-local, the orgTeamsLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const orgLabelsLocale = {
  labels: "Labels", // "repo.labels"
  labels_desc_1: "Add labels which can be used on issues for", // org.settings.labels_desc, split around the strong pair
  labels_desc_strong: "all repositories",
  labels_desc_2: "under this organization.",
  new_label: "New Label", // "repo.issues.new_label"
  label_title: "Name", // "repo.issues.label_title"
  label_color: "Color", // "repo.issues.label_color"
  labels_count: "labels", // "repo.issues.label_count"'s %d tail
  label_edit: "Edit", // "repo.issues.label_edit"
  label_delete: "Delete", // "repo.issues.label_delete"
  label_save: "Save", // "save" — the edit modal's approve button
  open_issues: "open issues/pull requests", // "repo.issues.label_open_issues"'s %d tail
  none: "No labels yet.", // cf-gitea addition (upstream renders the template loader's empty block)
  title_required: "Label name cannot be empty.", // cf-gitea addition (HTML5 required backs this)
} as const;

/** The modal color input's default (label_edit_modal.tmpl's value="#70c24a"). */
export const NEW_LABEL_DEFAULT_COLOR = "#70c24a";

/** List page cap (listOrgLabels is paginated; one page serves the slice —
 *  the HOOKS_LIST_LIMIT pattern; the header carries the true total). */
export const ORG_LABELS_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Data loading + the three writes (§3.2 — the landed labels-t2 arms)
// ---------------------------------------------------------------------------

/** The list page's render inputs. */
export interface OrgLabelsData {
  org: OrgRecord;
  labels: LabelRow[];
  /** The pagination-independent total (CountLabelsByOrgID) behind the header. */
  total: number;
}

/** The silent `sort` query, exactly the landed list arm's reading
 *  (routes/labels-t2.ts sortParam — unknown values take the default order). */
function sortParam(params: URLSearchParams): LabelSortType {
  const raw = params.get("sort") ?? "";
  return raw === "reversealphabetically" || raw === "leastissues" || raw === "mostissues" ? raw : "";
}

/** Load the management list (the landed orgListLabels read's owner-side arm —
 *  every org label, default alphabetical order). */
export async function loadOrgLabelsData(d1: D1Database, org: OrgRecord, params: URLSearchParams): Promise<OrgLabelsData> {
  const { items, total } = await listOrgLabels(d1, org.id, sortParam(params), 1, ORG_LABELS_LIST_LIMIT);
  return { org, labels: items, total };
}

/** The create/edit form's fields — upstream's CreateLabelForm names
 *  (`title`, `color`; the edit posts carry the hidden `id`). */
export interface OrgLabelForm {
  title: string;
  color: string;
}

/** Parse the urlencoded label POST (`title`, `color`; trim like upstream's
 *  bind — org.CreateLabel's own TrimSpace subsumed by the normalizer). */
export function parseOrgLabelForm(params: URLSearchParams): OrgLabelForm {
  return {
    title: (params.get("title") ?? "").trim(),
    color: params.get("color") ?? "",
  };
}

/** `ctx.PathParamInt64` parity for the form-borne `id`: strict decimal or 0
 *  (garbage ids never match a label). */
export function formLabelId(raw: string | null): number {
  return raw !== null && /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

/** The create/edit arms' failure shape: applied, the validation re-render,
 *  or — edit only — the missing-id 404 shell. */
export type OrgLabelApplyResult = { outcome: "applied" } | { outcome: "invalid"; message: string };
export type OrgLabelWriteResult = OrgLabelApplyResult | { outcome: "missing" };

/**
 * The create write (the orgCreateLabel arm): the empty-title guard re-renders
 * (the applyRepoBasics precedent — HTML5 required backs it), then
 * `normalizeLabelColor` (the arm's exact 422 message on failure) and
 * `createOrgLabel` (the arm's is_archived quirk rides along — the row is
 * never stamped archived on create).
 */
export async function createOrgLabelFromForm(d1: D1Database, orgId: number, form: OrgLabelForm): Promise<OrgLabelApplyResult> {
  if (form.title === "") {
    return { outcome: "invalid", message: orgLabelsLocale.title_required };
  }
  let color: string;
  try {
    color = normalizeLabelColor(form.color);
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
  await createOrgLabel(d1, orgId, { name: form.title, exclusive: false, color, description: "" });
  return { outcome: "applied" };
}

/**
 * The edit write (the orgEditLabel arm's order: the org-scoped lookup FIRST,
 * then the color normalization — a missing id 404-shells before any 422,
 * org/label.go:148-175): `findOrgLabelById` + `editRepoLabel` with only the
 * form's two fields (name + color) — description/exclusive/is_archived stay
 * untouched (the PATCH arm's absent-field rule).
 */
export async function editOrgLabelFromForm(d1: D1Database, orgId: number, id: number, form: OrgLabelForm): Promise<OrgLabelWriteResult> {
  const row = await findOrgLabelById(d1, orgId, id);
  if (row === null) {
    return { outcome: "missing" };
  }
  if (form.title === "") {
    return { outcome: "invalid", message: orgLabelsLocale.title_required };
  }
  let color: string;
  try {
    color = normalizeLabelColor(form.color);
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
  await editRepoLabel(d1, row, { name: form.title, color, now: new Date() });
  return { outcome: "applied" };
}

/**
 * The delete write (the orgDeleteLabel arm): the org-scoped lookup, the
 * cascade delete when the row exists, and SUCCESS either way — the landed
 * arm's zero-row-delete 204 semantics (org/label.go:214-224); the caller
 * answers both arms with the same 303 onto the list.
 */
export async function deleteOrgLabelFromForm(d1: D1Database, orgId: number, id: number): Promise<OrgLabelWriteResult> {
  const row = await findOrgLabelById(d1, orgId, id);
  if (row !== null) {
    await deleteRepoLabel(d1, row);
  }
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * The ContrastColor preview swatch (the wave-2 port — issues-list.tsx's
 * contrastColor over the same `#RRGGBB` trust rule as LabelBadge's
 * labelColor guard): the create form's live default and the per-row edit
 * forms' stored color, rendered as the badge the Gitea CSS shapes. Only a
 * stored 6-digit hex renders — anything else renders nothing (never break
 * the page).
 */
export function LabelColorSwatch(props: { color: string }) {
  const color = /^#[0-9a-fA-F]{6}$/.test(props.color) ? props.color : null;
  if (color === null) return null;
  return (
    <span
      class="ui label"
      style={`color: ${contrastColor(color)} !important; background-color: ${color} !important;`}
    >
      {color}
    </span>
  );
}

/** The two-field label form body (title + color + the preview swatch) —
 *  shared shape of the create form and the per-row edit disclosure. `id`
 *  prefixes the field ids/names so the per-row forms stay unique. */
function LabelFormFields(props: { prefix: string; form: OrgLabelForm; withId?: number }) {
  return (
    <>
      {props.withId !== undefined ? <input type="hidden" name="id" value={props.withId} /> : null}
      <div class="required field">
        <label for={`${props.prefix}_title`}>{orgLabelsLocale.label_title}</label>
        <input id={`${props.prefix}_title`} name="title" value={props.form.title} required maxlength={50} />
      </div>
      <div class="field">
        <label for={`${props.prefix}_color`}>{orgLabelsLocale.label_color}</label>
        <div class="flex-text-block">
          <input
            id={`${props.prefix}_color`}
            name="color"
            value={props.form.color}
            required
            pattern="^#?([\dA-Fa-f]{3}|[\dA-Fa-f]{6})$"
            maxlength={7}
          />
          <LabelColorSwatch color={props.form.color} />
        </div>
      </div>
    </>
  );
}

/** The open-issues count as text (the label_list.tmpl row's middle cell —
 *  the dashboard facet link is not a page this slice has). */
function LabelIssueCount(props: { label: LabelRow }) {
  const open = Math.max((props.label.numIssues ?? 0) - (props.label.numClosedIssues ?? 0), 0);
  return (
    <div class="label-issues">
      <span class="flex-text-inline">
        <Icon name="octicon-issue-opened" /> {open} {orgLabelsLocale.open_issues}
      </span>
    </div>
  );
}

/** The per-row edit disclosure (label_edit_modal.tmpl's no-JS reduction —
 *  the module header) + the delete button form. */
function LabelOperation(props: { orgLink: string; label: LabelRow }) {
  const { label } = props;
  return (
    <div class="label-operation">
      <details>
        <summary class="flex-text-inline">
          <Icon name="octicon-pencil" /> {orgLabelsLocale.label_edit}
        </summary>
        <form class="ui form" action={`${props.orgLink}/labels/edit`} method="post">
          <LabelFormFields prefix={`label-edit-${label.id}`} form={{ title: label.name, color: label.color ?? "" }} withId={label.id} />
          <div class="field">
            <button type="submit" class="ui tiny primary button">
              {orgLabelsLocale.label_save}
            </button>
          </div>
        </form>
      </details>
      <form class="tw-inline-block" action={`${props.orgLink}/labels/delete`} method="post">
        <input type="hidden" name="id" value={label.id} />
        <button type="submit" class="ui tiny button">
          {orgLabelsLocale.label_delete}
        </button>
      </form>
    </div>
  );
}

/** One label_list.tmpl row: the wave-2 badge (ContrastColor), the optional
 *  description line, the issue count, the edit/delete controls. */
export function OrgLabelRow(props: { orgLink: string; label: LabelRow }) {
  const description = props.label.description ?? "";
  return (
    <li class="item">
      <div class="label-title">
        <LabelBadge label={props.label} />
        {description !== "" ? (
          <>
            <br />
            <small class="desc">{description}</small>
          </>
        ) : null}
      </div>
      <LabelIssueCount label={props.label} />
      <LabelOperation orgLink={props.orgLink} label={props.label} />
    </li>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderOrgLabelsPage(options: {
  ctx: UiContext;
  data: OrgLabelsData;
  /** The create form's re-rendered submission (the plain GET defaults). */
  form: OrgLabelForm;
  error: string | null;
}): string {
  return renderPage(
    <OrgLabelsPage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />,
  );
}

/** The org labels management page (§2.4.1 discriminator: `organization
 *  settings labels` — org/settings/labels.tmpl at the pin; the URL is the
 *  brief's literal, the module header's divergence note). */
export function OrgLabelsPage(props: { ctx: UiContext; data: OrgLabelsData; form: OrgLabelForm; error: string | null }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  return (
    <BaseLayout ctx={ctx} title={orgLabelsLocale.labels} pageClass="organization settings labels">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container">
        {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
        {/* The prompt row (labels.tmpl's flex-text-block; the New Label
            button is the modal's opener — the inline form below is the
            no-JS create arm). */}
        <div class="flex-text-block">
          <div class="tw-flex-1">
            {orgLabelsLocale.labels_desc_1} <strong>{orgLabelsLocale.labels_desc_strong}</strong>{" "}
            {orgLabelsLocale.labels_desc_2}
          </div>
        </div>
        <div class="divider"></div>
        {/* The create form (the modal's two brief fields). */}
        <h4 class="ui top attached header">{orgLabelsLocale.new_label}</h4>
        <div class="ui attached segment">
          <form class="ui form" action={`${orgLink}/labels/new`} method="post">
            <LabelFormFields prefix="new-label" form={props.form} />
            <div class="field">
              <button type="submit" class="ui primary button">
                {orgLabelsLocale.new_label}
              </button>
            </div>
          </form>
        </div>
        {/* The list (label_list.tmpl's header count + .issue-label-list). */}
        <h4 class="ui top attached header">
          {data.total} {orgLabelsLocale.labels_count}
        </h4>
        <div class="ui attached segment">
          {data.labels.length === 0 ? (
            <div>{orgLabelsLocale.none}</div>
          ) : (
            <ul class="issue-label-list muted-links">
              {data.labels.map((label) => (
                <OrgLabelRow orgLink={orgLink} label={label} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </BaseLayout>
  );
}
