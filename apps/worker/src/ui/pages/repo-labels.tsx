/**
 * The repo labels management page — pages wave 25 (the UI-parity survey's
 * TOP-2 dispatchable row, docs/compat/ui-parity-survey.md): the label list
 * (`GET /{owner}/{repo}/labels`, web.go:1338 `repo.RetrieveLabelsForList,
 * repo.Labels` in the optSignIn + RepoAssignment + reqRepoIssuesOrPullsReader
 * group) plus the create/edit/delete writes (web.go:1417-1422's
 * `m.Group("/labels")`: `POST /labels/new`, `/labels/edit`, `/labels/delete`
 * under reqSignIn + RepoAssignment + RepoMustNotBeArchived +
 * reqRepoIssuesOrPullsWriter), all over the landed repo-label service family
 * (src/api/services/labels.ts — the tier-1 issueListLabels/issueCreateLabel/
 * issueEditLabel/issueDeleteLabel reads and writes, routes/labels.ts).
 * `pages/org-labels.tsx` (wave 14) is the template: the same list DOM, the
 * same no-JS two-field form, the same POST-write pattern — the repo-scoped
 * twin.
 *
 * ## Gates (the groups' order, reduced to the landed model)
 *
 * - The LIST answers for every viewer who can see the repo (optSignIn +
 *   reqRepoIssuesOrPullsReader — RequireSignInViewStrict is off at the pin;
 *   the §2.5 read grant IS the reader arm, no landed units).
 * - The WRITES: anonymous 303s onto the login round-trip (reqSignIn), an
 *   archived repo 404-shells (RepoMustNotBeArchived — the archived posture
 *   the render hides the controls for), a signed-in viewer without the
 *   writer grant 404-shells (reqRepoIssuesOrPullsWriter ported to the
 *   landed `canWriteRepository` — the units model is absent, the general
 *   write grant is the writer arm the grants bridge evaluates; the render
 *   gate and the write seam share the one predicate, repo-grants.ts).
 * - `POST /labels/initialize` (the upstream label-template loader) stays
 *   unclaimed → the engine's 404: no landed template catalog (the
 *   org-labels precedent).
 *
 * ## DOM contract (templates/repo/issue/labels.tmpl +
 *  labels/label_list.tmpl + label_edit_modal.tmpl + label_archived.tmpl at
 *  the pin)
 *
 * `.page-content.repository labels` (activeTab issues — upstream sets
 * `PageIsIssueList`), then the `.issue-navbar` compact menu
 * (repo/issue/navbar.tmpl: the Labels item ACTIVE + the Milestones item —
 * both pages landed; the milestones page's menu carries the Labels item
 * since this wave, the disclosed additive hunk), then the writer's New
 * Label control and the label_list: the count header
 * (`repo.issues.label_count` — lifted h4→h3, the tags page's a11y R2 lift
 * after the h2 navbar), the `.issue-label-list` rows — the RenderLabel
 * badge (issues-list.tsx's LabelBadge), the optional description line, the
 * open-count anchor onto the LIVE issues facet
 * (`/{repoLink}/issues?labels={id}` — parseLabelIds), the archived marker
 * (label_archived.tmpl, `archivedAt !== null`) and — writers only — the
 * edit/delete controls (the modal reduced to a per-row `<details>`
 * disclosure, the org-labels no-JS posture).
 *
 * The ORG section (label_list.tmpl's `.OrgLabels` arm): an org-owned repo
 * appends the intro row — the org_labels_desc sentence with the
 * "(manage)" link for org owners (upstream targets
 * `{OrganizationLink}/settings/labels`; the landed page lives at
 * `/{org}/labels`, the org-labels module's documented divergence, so the
 * link emits the live URL) — followed by the org label rows (badge +
 * description + count anchor; NEVER edit/delete controls).
 *
 * ## Write paths (§3.2 — the landed services, never a self-fetch)
 *
 * - Create: the empty-title guard re-renders (HTML5 required backs it),
 *   then `normalizeLabelColor` (the arm's exact 422 message inline) and
 *   `createRepoLabel` — the API create arm's exact call with
 *   exclusive=false/description=""/isArchived=false (the brief's two-field
 *   form; the API route takes the same defaults through its optionals).
 * - Edit: `findRepoLabelById` (repo-scoped — another repo's id 404-shells,
 *   the landed PATCH arm's lookup order: the missing id 404s BEFORE any
 *   422, issue_label.go:148-152's JSONErrorNotFound arm) +
 *   `editRepoLabel` with only the form's two fields — description/
 *   exclusive/is_archived stay untouched (the absent-field rule).
 * - Delete: `findRepoLabelById` + `deleteRepoLabel` (the cascade arm); a
 *   missing label deletes zero rows and still succeeds — the landed DELETE
 *   arm's 204 semantics (and upstream DeleteLabel's unconditional
 *   JSONRedirect) answered as a 303 back onto the list, so a repeated or
 *   raced delete is idempotent.
 * - Every write runs the §2.8 sameOriginGuard at the handler (index.ts);
 *   success 303s onto `/{owner}/{repo}/labels` (upstream's JSONRedirect
 *   target), validation failures re-render at 200 with the banner and the
 *   kept create-form submission (the org-labels convention).
 *
 * ## Documented v1 degradations (§6 method, the org-labels reductions
 *  carried over)
 *
 * - The sort dropdown (label_list.tmpl's JS dropdown) is not rendered; the
 *   silent `?sort=` query is honored exactly like the landed list arm
 *   (never declared upstream — routes/labels.ts's sortParam), unknown
 *   values taking the default alphabetical order.
 * - The New Label button (the modal's opener) is the no-JS inline create
 *   form (the org-labels reduction) under its own `h4`-level "New Label"
 *   header; the modal's exclusive/exclusive_order/is_archived/description
 *   fields are not rendered.
 * - The label-template loader block (label_load_template.tmpl, rendered to
 *   writers on an empty list) is unrendered: no landed template catalog
 *   (the same arm that keeps /labels/initialize unclaimed). The empty list
 *   renders the org-labels page's cf-gitea "No labels yet." line instead.
 * - The list caps at one page of 50 with no pager (the org-labels cap
 *   pattern — upstream RetrieveLabelsForList lists unbounded); the count
 *   header carries the pagination-independent total (upstream NumLabels =
 *   len(labels) of the same unbounded read; the cap makes them diverge
 *   only past 50 labels).
 * - The open-count text renders the maintained repo-scoped counters
 *   (`numIssues - numClosedIssues`, the same numbers the API LIST emits);
 *   for ORG label rows the landed listOrgLabels counters are org-wide, not
 *   the per-repo NumOpenRepoIssues upstream computes here (CalOpenOrgIssues
 *   — the org-wide number is what the landed service maintains).
 * - A failed per-row edit re-renders with the error banner and the STORED
 *   row values (the rows are list-rendered; only the create form is
 *   submission-bound). The only edit failures the seam can produce are the
 *   color 422 and the empty title, and the banner names them.
 */

import { ApiError } from "../../api/errors";
import {
  createRepoLabel,
  deleteRepoLabel,
  editRepoLabel,
  findRepoLabelById,
  listRepoLabels,
  normalizeLabelColor,
  type LabelSortType,
} from "../../api/services/labels";
import { listOrgLabels } from "../../api/services/labels-t2";
import type { LabelRow } from "../../issues/service";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { canWriteRepo } from "./file-editor";
import { loadOwnerIsOrg } from "./branch-protection";
import { isOrgOwnerViewer } from "./org-members";
import { LabelColorSwatch } from "./org-labels";
import { LabelBadge } from "./issues-list";import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (component-local, the orgLabelsLocale pattern — locale.ts
 *  is shared and not this wave's file; upstream locale keys cited). */
export const repoLabelsLocale = {
  labels: "Labels", // "repo.labels"
  milestones: "Milestones", // "repo.milestones" (the navbar's second item)
  new_label: "New Label", // "repo.issues.new_label"
  label_title: "Name", // "repo.issues.label_title"
  label_color: "Color", // "repo.issues.label_color"
  labels_count: "labels", // "repo.issues.label_count"'s %d tail
  label_edit: "Edit", // "repo.issues.label_edit"
  label_delete: "Delete", // "repo.issues.label_delete"
  label_save: "Save", // "save" — the edit modal's approve button
  open_issues: "open issues/pull requests", // "repo.issues.label_open_issues"'s %d tail
  archived: "Archived", // "archived" (label_archived.tmpl's marker text)
  archived_tooltip: "Archived labels are excluded by default from the suggestions when searching by label.", // "repo.issues.label_archive_tooltip"
  org_labels_desc_1: "Organization-level labels that can be used with", // "repo.org_labels_desc", split around the strong pair
  org_labels_desc_strong: "all repositories",
  org_labels_desc_2: "under this organization",
  org_labels_manage: "(manage)", // "repo.org_labels_desc_manage"
  none: "No labels yet.", // cf-gitea addition (the org-labels page's empty arm)
  title_required: "Label name cannot be empty.", // cf-gitea addition (HTML5 required backs this)
} as const;

/** List page cap (listRepoLabels is paginated; one page serves the slice —
 *  the org-labels page's ORG_LABELS_LIST_LIMIT pattern; the count header
 *  carries the true total). */
export const REPO_LABELS_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed labels arms)
// ---------------------------------------------------------------------------

/** The org section's render inputs (an org-owned repo only; `null` when the
 *  owner is a user or the org carries no labels — upstream's empty-arm). */
export interface RepoOrgLabelsSection {
  org: OrgRecord;
  labels: LabelRow[];
  /** The "(manage)" link's gate (upstream IsOrganizationOwner). */
  canManage: boolean;
}

/** The list page's render inputs. */
export interface RepoLabelsData {
  labels: LabelRow[];
  /** The pagination-independent total (CountLabelsByRepoID) behind the
   *  count header. */
  total: number;
  /** The writer grant behind the New Label form + the per-row controls
   *  (upstream `.CanWriteIssues | .CanWritePulls` — the module header's
   *  gate note). */
  canWrite: boolean;
  orgSection: RepoOrgLabelsSection | null;
}

/** The silent `sort` query, exactly the landed list arm's reading
 *  (routes/labels.ts — unknown values take the default order). */
function sortParam(params: URLSearchParams): LabelSortType {
  const raw = params.get("sort") ?? "";
  return raw === "reversealphabetically" || raw === "leastissues" || raw === "mostissues" ? raw : "";
}

/**
 * Load the management list: the repo labels page (one capped read), the
 * writer grant (the render gate — the same predicate the write seam
 * enforces), and — org-owned repos — the upstream `.OrgLabels` section over
 * the landed org-label read.
 */
export async function loadRepoLabelsData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<RepoLabelsData> {
  const sort = sortParam(params);
  const [{ items, total }, canWrite] = await Promise.all([
    listRepoLabels(d1, repo.id, sort, 1, REPO_LABELS_LIST_LIMIT),
    canWriteRepo(env, repo, viewer),
  ]);

  let orgSection: RepoOrgLabelsSection | null = null;
  if (await loadOwnerIsOrg(d1, repo)) {
    const org = await new OrgService(d1).getOrgByUsername(repo.ownerNamespace);
    if (org !== null) {
      const orgLabels = await listOrgLabels(d1, org.id, sort, 1, REPO_LABELS_LIST_LIMIT);
      // Upstream renders the section only when the org carries labels
      // (label_list.tmpl's `{{if .OrgLabels}}`).
      if (orgLabels.items.length > 0) {
        orgSection = {
          org,
          labels: orgLabels.items,
          canManage: await isOrgOwnerViewer(d1, org, viewer),
        };
      }
    }
  }

  return { labels: items, total, canWrite, orgSection };
}

// ---------------------------------------------------------------------------
// The three writes (§3.2 — the landed labels arms, the org-labels pattern)
// ---------------------------------------------------------------------------

/** The create/edit form's fields — upstream's CreateLabelForm names
 *  (`title`, `color`; the edit posts carry the hidden `id`). */
export interface RepoLabelForm {
  title: string;
  color: string;
}

/** Parse the urlencoded label POST (`title`, `color`; trimmed like
 *  upstream's bind). */
export function parseRepoLabelForm(params: URLSearchParams): RepoLabelForm {
  return {
    title: (params.get("title") ?? "").trim(),
    color: params.get("color") ?? "",
  };
}

/** The create/edit arms' failure shape: applied, the validation re-render,
 *  or — edit only — the missing-id 404 shell. */
export type RepoLabelApplyResult = { outcome: "applied" } | { outcome: "invalid"; message: string };
export type RepoLabelWriteResult = RepoLabelApplyResult | { outcome: "missing" };

/** The create write (the API create arm's exact sequence): the empty-title
 *  guard, then `normalizeLabelColor` (the 422 message inline), then
 *  `createRepoLabel` with the two-field form's defaults. */
export async function createRepoLabelFromForm(d1: D1Database, repoId: string, form: RepoLabelForm): Promise<RepoLabelApplyResult> {
  if (form.title === "") {
    return { outcome: "invalid", message: repoLabelsLocale.title_required };
  }
  let color: string;
  try {
    color = normalizeLabelColor(form.color);
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
  await createRepoLabel(d1, repoId, { name: form.title, exclusive: false, color, description: "", isArchived: false, now: new Date() });
  return { outcome: "applied" };
}

/**
 * The edit write (upstream UpdateLabel's order: the repo-scoped lookup
 * FIRST — a missing id 404-shells before any 422, issue_label.go:148-152's
 * JSONErrorNotFound arm — then the color): `findRepoLabelById` +
 * `editRepoLabel` with only the form's two fields (name + color);
 * description/exclusive/is_archived stay untouched (the PATCH arm's
 * absent-field rule).
 */
export async function editRepoLabelFromForm(d1: D1Database, repoId: string, id: number, form: RepoLabelForm): Promise<RepoLabelWriteResult> {
  const row = await findRepoLabelById(d1, repoId, id);
  if (row === null) {
    return { outcome: "missing" };
  }
  if (form.title === "") {
    return { outcome: "invalid", message: repoLabelsLocale.title_required };
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
 * The delete write (upstream DeleteLabel over the landed cascade arm): the
 * repo-scoped lookup, the delete when the row exists, and SUCCESS either
 * way — the landed arm's zero-row-delete 204 semantics (and upstream's
 * unconditional JSONRedirect) answered as a 303 onto the list, so a
 * repeated (or raced) delete is idempotent.
 */
export async function deleteRepoLabelFromForm(d1: D1Database, repoId: string, id: number): Promise<RepoLabelWriteResult> {
  const row = await findRepoLabelById(d1, repoId, id);
  if (row !== null) {
    await deleteRepoLabel(d1, row);
  }
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The two-field label form body (title + color + the preview swatch) —
 *  the org-labels page's LabelFormFields shape (its copy is private; the
 *  modal's remaining fields are the documented reduction). `id` prefixes
 *  the field ids so the per-row forms stay unique. */
function LabelFormFields(props: { prefix: string; form: RepoLabelForm; withId?: number }) {
  return (
    <>
      {props.withId !== undefined ? <input type="hidden" name="id" value={props.withId} /> : null}
      <div class="required field">
        <label for={`${props.prefix}_title`}>{repoLabelsLocale.label_title}</label>
        <input id={`${props.prefix}_title`} name="title" value={props.form.title} required maxlength={50} />
      </div>
      <div class="field">
        <label for={`${props.prefix}_color`}>{repoLabelsLocale.label_color}</label>
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

/** The open-count anchor (the label_list.tmpl row's middle cell — LIVE:
 *  the landed issues list parses `?labels=`). */
function LabelIssueCount(props: { repoLink: string; label: LabelRow }) {
  const open = Math.max((props.label.numIssues ?? 0) - (props.label.numClosedIssues ?? 0), 0);
  return (
    <div class="label-issues">
      <a class="open-issues" href={`${props.repoLink}/issues?labels=${props.label.id}`}>
        <span class="flex-text-inline">
          <Icon name="octicon-issue-opened" /> {open} {repoLabelsLocale.open_issues}
        </span>
      </a>
    </div>
  );
}

/** label_archived.tmpl's marker (the stored `archivedAt` — the landed arm's
 *  SetArchived stamp). */
function ArchivedMarker() {
  return (
    <span class="ui label basic small" data-tooltip-content={repoLabelsLocale.archived_tooltip}>
      {repoLabelsLocale.archived}
    </span>
  );
}

/** The per-row edit disclosure (label_edit_modal.tmpl's no-JS reduction —
 *  the org-labels posture) + the delete button form. */
function LabelOperation(props: { repoLink: string; label: LabelRow }) {
  const { label } = props;
  return (
    <div class="label-operation">
      {label.archivedAt !== null ? <ArchivedMarker /> : null}
      <details>
        <summary class="flex-text-inline">
          <Icon name="octicon-pencil" /> {repoLabelsLocale.label_edit}
        </summary>
        <form class="ui form" action={`${props.repoLink}/labels/edit`} method="post">
          <LabelFormFields prefix={`label-edit-${label.id}`} form={{ title: label.name, color: label.color ?? "" }} withId={label.id} />
          <div class="field">
            <button type="submit" class="ui tiny primary button">
              {repoLabelsLocale.label_save}
            </button>
          </div>
        </form>
      </details>
      <form class="tw-inline-block" action={`${props.repoLink}/labels/delete`} method="post">
        <input type="hidden" name="id" value={label.id} />
        <button type="submit" class="ui tiny button">
          {repoLabelsLocale.label_delete}
        </button>
      </form>
    </div>
  );
}

/** One label_list.tmpl repo row: the badge, the optional description, the
 *  count anchor, the controls (writers only). */
export function RepoLabelRow(props: { repoLink: string; label: LabelRow; canEdit: boolean }) {
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
      <LabelIssueCount repoLink={props.repoLink} label={props.label} />
      {props.canEdit ? <LabelOperation repoLink={props.repoLink} label={props.label} /> : <div class="label-operation" />}
    </li>
  );
}

/** The org section's rows (label_list.tmpl's `.org-label` arm — badge +
 *  description + count anchor, NEVER the edit/delete controls). */
function OrgLabelRowLine(props: { repoLink: string; label: LabelRow }) {
  const description = props.label.description ?? "";
  return (
    <li class="item org-label">
      <div class="label-title">
        <LabelBadge label={props.label} />
        {description !== "" ? (
          <>
            <br />
            <small class="desc">{description}</small>
          </>
        ) : null}
      </div>
      <LabelIssueCount repoLink={props.repoLink} label={props.label} />
      <div class="label-operation" />
    </li>
  );
}

/** The `.issue-navbar` compact menu (repo/issue/navbar.tmpl) — Labels
 *  ACTIVE, Milestones the sibling item (both pages landed; the milestones
 *  page carries the reciprocal item since this wave). */
function LabelsNavbar(props: { repoLink: string }) {
  return (
    <h2 class="ui compact small menu small-menu-items issue-list-navbar">
      <a class="active item" href={`${props.repoLink}/labels`}>
        {repoLabelsLocale.labels}
      </a>
      <a class="item" href={`${props.repoLink}/milestones`}>
        {repoLabelsLocale.milestones}
      </a>
    </h2>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderRepoLabelsPage(options: {
  ctx: UiContext;
  data: RepoLabelsData;
  /** The create form's re-rendered submission (the plain GET defaults). */
  form: RepoLabelForm;
  error: string | null;
}): string {
  return renderPage(
    <RepoLabelsPage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />,
  );
}

/** The repo labels management page (§2.4.1 discriminator: the template's
 *  literal `repository labels`). */
export function RepoLabelsPage(props: { ctx: UiContext; data: RepoLabelsData; form: RepoLabelForm; error: string | null }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoLabelsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  // Upstream's canEditLabel: writers on a non-archived repo (the org-labels
  // management page's unconditional grant is the org-owner gate instead).
  const canEdit = data.canWrite && !repo.isArchived;
  return (
    <BaseLayout ctx={ctx} title={repoLabelsLocale.labels} pageClass="repository labels" activeTab="issues">
      <div class="ui container">
        {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
        {/* labels.tmpl's `.issue-navbar` — the menu + the writer's New Label
            control (the button is the modal's opener upstream; the inline
            form below is the no-JS create arm). */}
        <div class="issue-navbar tw-mb-4">
          <LabelsNavbar repoLink={repoLink} />
          {canEdit ? (
            <a class="ui small primary new-label button" href={`${repoLink}/labels#new-label`}>
              {repoLabelsLocale.new_label}
            </a>
          ) : null}
        </div>

        {/* The count header (upstream's h4 lifted to h3 — the tags page's
            a11y R2 lift after the h2 navbar); the sort dropdown is the
            documented reduction. */}
        <h3 class="ui top attached header">
          {data.total} {repoLabelsLocale.labels_count}
        </h3>
        <div class="ui attached segment">
          {/* The list renders whenever EITHER arm has rows — an org-owned
              repo with no repo labels still shows the .OrgLabels section
              (label_list.tmpl keeps the single ul around both arms). */}
          {data.labels.length === 0 && data.orgSection === null ? (
            <div>{repoLabelsLocale.none}</div>
          ) : (
            <ul class="issue-label-list muted-links">
              {data.labels.map((label) => (
                <RepoLabelRow repoLink={repoLink} label={label} canEdit={canEdit} />
              ))}
              {/* The org section (label_list.tmpl's `.OrgLabels` arm — an
                  org-owned repo only, non-empty only). */}
              {data.orgSection !== null ? (
                <>
                  <li class="item">
                    <div>
                      {repoLabelsLocale.org_labels_desc_1} <strong>{repoLabelsLocale.org_labels_desc_strong}</strong>{" "}
                      {repoLabelsLocale.org_labels_desc_2}
                      {data.orgSection.canManage ? (
                        <a href={`/${data.orgSection.org.username}/labels`}> {repoLabelsLocale.org_labels_manage}</a>
                      ) : null}
                      :
                    </div>
                  </li>
                  {data.orgSection.labels.map((label) => (
                    <OrgLabelRowLine repoLink={repoLink} label={label} />
                  ))}
                </>
              ) : null}
            </ul>
          )}
        </div>

        {/* The create form (the modal's two brief fields; the writer-only
            arm — upstream renders the modal to the same gate). */}
        {canEdit ? (
          <>
            <h4 class="ui top attached header" id="new-label">
              {repoLabelsLocale.new_label}
            </h4>
            <div class="ui attached segment">
              <form class="ui form" action={`${repoLink}/labels/new`} method="post">
                <LabelFormFields prefix="new-label" form={props.form} />
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {repoLabelsLocale.new_label}
                  </button>
                </div>
              </form>
            </div>
          </>
        ) : null}
      </div>
    </BaseLayout>
  );
}
