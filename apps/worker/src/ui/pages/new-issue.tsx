/**
 * The new-issue page, `/{owner}/{repo}/issues/new` — pages wave 4 (SPEC-0008
 * U3 extension, the first AUTHED WRITE surface in the §2.1 inventory).
 *
 * ## DOM contract (templates/repo/issue/new.tmpl + new_form.tmpl +
 *  comment_tab.tmpl + sidebar/label_list.tmpl + sidebar/milestone_list.tmpl
 *  at the pin)
 *
 * `.page-content.repository.new issue`, then one `.ui.container` holding the
 * upstream `<form class="issue-content ui comment form" id="new-issue"
 * action="{repoLink}/issues/new" method="post">` two-column grid:
 * `.issue-content-left > .ui.comments > .comment > .ui.segment.content`
 * (title `<input name="title">`, the body `<textarea name="content">`, the
 * submit row) and `.issue-content-right.ui.segment` (the reduced sidebar:
 * the label multi-select and the milestone select).
 *
 * ## Auth + CSRF posture (SPEC-0010 §2.5/§2.8 — the session wave's shape)
 *
 * The page renders for the signed-in viewer ONLY. The router resolves the
 * repo first (invisible/unknown repos 404-shell — existence never leaks,
 * §2.5), then an anonymous viewer is 303-redirected onto
 * `/login?redirect_to={this path}` (the session router's own round-trip: the
 * login POST carries the hidden `redirect_to` back here through
 * `safeRedirectTarget`). The POST runs the §2.8 layer-2 Origin/Referer check
 * (`sameOriginGuard`, session.ts) — the same convention as /login and
 * /logout; there is no CSRF token (layer 1 is the SameSite=Lax cookie).
 *
 * ## Write path (§3.2 — direct service calls, never a self-fetch)
 *
 * The POST handler parses the urlencoded form and calls the tier-1
 * `IssuesService.createIssue` (src/issues/service.ts) with the session
 * viewer as poster; success 303s onto the created issue's detail page
 * (`/{owner}/{repo}/issues/{index}`, upstream's `ctx.Redirect(issue.Link)`,
 * 303 per services/context/base.go:157). Validation failures (empty title,
 * unknown label/milestone id — the service's IssueError) re-render the form
 * at 200 with the message and the submitted values preserved, exactly the
 * login page's failure convention. Success fans the SAME `issues` "opened"
 * webhook out through the shared issue-family seam (services/issue-events.ts
 * `emitSessionIssueOpened`) the API POST route runs — the wave-4 divergence
 * (web-created issues invisible to hook subscribers) is closed; the emission
 * is best-effort and never fails the write.
 *
 * ## Documented v1 degradations (data/services that have not landed, §6)
 *
 * - The combo markdown editor (shared/combomarkdowneditor + easymde) and the
 *   attachment dropzone reduce to a plain `<textarea>` — the editor toolbar
 *   is a client bundle feature and uploads are a write surface of their own.
 *   The body still renders through the §3.4 markdown pipeline on the detail
 *   page.
 * - The sidebar reduces to labels + milestone: assignees (user search),
 *   projects (no projects service) and the branch-selector field (engine
 *   ref reads) are not rendered; the labels list offers the repo's labels as
 *   plain `.ui.checkbox` entries (upstream's Fomantic dropdown needs the
 *   jQuery search/scrolling menu; checkboxes are the no-JS shape the built
 *   CSS styles and post the same `label_ids` multi-value field).
 * - Issue templates (SPEC-0005 §11): OFFERED since the ISSUE-TEMPLATE
 *   pipeline landed — `?template=` + the 18 fallback candidates prefill the
 *   title/labels/body; a yaml template renders its form FIELDS (input/
 *   textarea/dropdown/checkboxes/markdown per upstream's field templates)
 *   and the POST renders them to markdown via the upstream byte contract.
 *   The recorded reductions (SPEC §11.3): the dropdown is a native select
 *   (repeated values comma-joined back to the hidden-input contract), the
 *   combo markdown editor stays a plain textarea, assignees/branch-selector
 *   sidebar prefills are parsed but not rendered, and the invalid-template
 *   flash is an in-page warning block.
 * - Org labels are not offered (repo labels only, listRepoLabels) — the
 *   org-label drop rule still guards the write via the service.
 * - The label/milestone pickers cap at 100 entries each (one page read; the
 *   upstream dropdowns page too, through the JS fetch path).
 * - Archived repos refuse the write (the API create route's
 *   `assertNotArchived` posture): the POST re-renders with the upstream 423
 *   message and the list page hides the New button.
 */

import { IssuesService } from "../../issues/service";
import { IssueError } from "../../issues/errors";
import type { IssueRow, LabelRow, MilestoneRow } from "../../issues/service";
import { listRepoLabels } from "../../api/services/labels";
import { listRepoMilestones } from "../../api/services/milestones";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import { branchRef, engineReads, refTipMap } from "../../api/services/engine";
import {
  ISSUE_TEMPLATE_CANDIDATES,
  renderTemplateToMarkdown,
  unmarshalTemplateBlob,
  visibleOnForm,
  type FormValues,
  type IssueFormField,
  type IssueTemplate,
} from "./issue-templates";
import { formatTemplateErrors, issueNewChooseLocale } from "./issue-new-choose";
import { emitSessionIssueOpened, type IssueEventRequest } from "../../services/issue-events";
import { readUrlEncodedForm } from "../forms";
import { LabelBadge } from "./issues-list";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the issuesLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const newIssueLocale = {
  create: "Create Issue", // "repo.issues.create"
  title_placeholder: "Title", // "repo.milestones.title" (the title input's placeholder upstream)
  content_placeholder: "", // "repo.diff.comment.placeholder" left empty: the plain-textarea reduction
  labels: "Labels", // "repo.issues.new.labels"
  no_labels: "No labels", // "repo.issues.new.no_labels"
  milestone: "Milestone", // "repo.issues.new.milestone"
  no_milestone: "No Milestone", // "repo.issues.new.no_milestone"
  /** cf-gitea addition: upstream's HTML5 `required` catches the empty title
   *  client-side; this is the server-side re-render message for non-browser
   *  submits (the login failure re-render shape). */
  title_required: "A title is required.",
  /** The archived refusal — upstream `mustNotBeArchived`'s exact message
   *  (routers/api/v1/api.go:816), carried into the re-render. */
  repo_archived: "repo is archived",
} as const;

/** Sidebar picker caps (header comment: one page read each). */
export const NEW_ISSUE_PICKER_LIMIT = 100;

// ---------------------------------------------------------------------------
// Data loading (§3.2 direct service calls)
// ---------------------------------------------------------------------------

/** The form's sidebar options, loaded by loadNewIssueData. */
export interface NewIssueData {
  /** The repo's labels, `name ASC` (listRepoLabels' default order). */
  labels: LabelRow[];
  /** The repo's OPEN milestones, `deadline ASC, name ASC`. */
  milestones: MilestoneRow[];
}

export async function loadNewIssueData(d1: D1Database, repoId: string): Promise<NewIssueData> {
  const [labels, milestones] = await Promise.all([
    listRepoLabels(d1, repoId, "", 1, NEW_ISSUE_PICKER_LIMIT),
    listRepoMilestones(d1, repoId, { state: "open", name: "", page: 1, limit: NEW_ISSUE_PICKER_LIMIT }),
  ]);
  return { labels: labels.items, milestones: milestones.items };
}

// ---------------------------------------------------------------------------
// Form parsing + the write (§3.2 — IssuesService.createIssue directly)
// ---------------------------------------------------------------------------

/** The parsed `application/x-www-form-urlencoded` submission. */
export interface NewIssueForm {
  title: string;
  content: string;
  labelIds: number[];
  milestoneId: number | null;
  /** The yaml-template form's hidden carrier (upstream `ctx.Req.Form.Get
   *  "template-file"`, issue_new.go:355); null = the plain textarea path. */
  templateFile: string | null;
  /** The FULL parsed params — the `form-field-*` values the template render
   *  reads (`RenderToMarkdown(template, ctx.Req.Form)`, issue_new.go:357;
   *  repeated keys resolve to their FIRST value like url.Values.Get). */
  fieldParams: URLSearchParams;
}

/** Parse the POST body: `title`/`content` single-value, `label_ids`
 *  multi-value (the checkbox group), `milestone_id` single-value ("": none;
 *  non-numeric and non-positive degrade to none — the select only emits
 *  known ids). Title is trimmed like upstream's form binding whitespace
 *  handling; the length cap is the service's own
 *  `ellipsisDisplayString(title, 255)`. */
export function parseNewIssueForm(params: URLSearchParams): NewIssueForm {
  const labelIds = [...new Set(
    params
      .getAll("label_ids")
      .map((entry) => Number.parseInt(entry, 10))
      .filter((entry) => Number.isInteger(entry) && entry > 0),
  )];
  const milestoneRaw = (params.get("milestone_id") ?? "").trim();
  const milestoneId = /^\d+$/.test(milestoneRaw) && Number.parseInt(milestoneRaw, 10) > 0
    ? Number.parseInt(milestoneRaw, 10)
    : null;
  const templateFile = (params.get("template-file") ?? "").trim();
  return {
    title: (params.get("title") ?? "").trim(),
    content: params.get("content") ?? "",
    labelIds,
    milestoneId,
    templateFile: templateFile === "" ? null : templateFile,
    fieldParams: params,
  };
}

export type NewIssueSubmitResult =
  | { outcome: "created"; issue: IssueRow }
  | { outcome: "invalid"; message: string };

/** The write's webhook-fan-out inputs, handed over by the POST handler (the
 *  hono request source + the instance origin). Omitted → no emission (the
 *  historical shape; every real caller passes it). */
export interface NewIssueEmission {
  request: IssueEventRequest;
  origin: string;
}

/**
 * The write: validate the title, then the tier-1 service with the session
 * viewer as poster. A rejected label/milestone id surfaces as the service's
 * IssueError message (the API's 404 body text) re-rendered inline — never a
 * partial write (createIssue batches its statements). On success the SAME
 * `issues` "opened" webhook the API POST route emits fans out through the
 * shared seam (best-effort — a fan-out failure never fails the created
 * issue, the emission function's own catch-and-log posture).
 */
export async function createIssueFromForm(
  d1: D1Database,
  repoId: string,
  form: NewIssueForm,
  posterId: number,
  emission?: NewIssueEmission,
): Promise<NewIssueSubmitResult> {
  if (form.title === "") return { outcome: "invalid", message: newIssueLocale.title_required };
  try {
    const issue = await new IssuesService(d1).createIssue({
      repoId,
      title: form.title,
      content: form.content === "" ? null : form.content,
      posterId,
      milestoneId: form.milestoneId,
      labelIds: form.labelIds,
    });
    if (emission !== undefined) {
      await emitSessionIssueOpened({ request: emission.request, origin: emission.origin, repoId, issue, posterId });
    }
    return { outcome: "created", issue };
  } catch (error) {
    if (error instanceof IssueError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}

/** Parse the urlencoded POST body; oversized/non-form bodies parse as empty
 *  (→ the title-required re-render, the login parse convention — the byte
 *  cap lives in the shared reader, ui/forms.ts). */
export async function readNewIssueForm(req: Request): Promise<NewIssueForm> {
  return parseNewIssueForm(await readUrlEncodedForm(req));
}

// ---------------------------------------------------------------------------
// Issue-template prefill (SPEC-0005 §11 — upstream setTemplateIfExists,
// routers/web/repo/issue_new.go:40-96)
// ---------------------------------------------------------------------------

/** The repo slice the template reads need (the resolved UiRequest row). */
export interface NewIssueTemplateRepo {
  ownerNamespace: string;
  slug: string;
  defaultBranch: string;
}

/** The GET's template state (setTemplateIfExists' outputs). */
export interface NewIssuePrefill {
  /** The first candidate template that loaded (null = none — the plain
   *  form; upstream's `templateLoaded == false`). */
  template: IssueTemplate | null;
  /** The candidates' PARSE errors (util.ErrNotExist arms are NOT errors —
   *  a missing file just falls through; issue_new.go:55-60). */
  templateErrors: Map<string, string>;
  /** The ?title= / ?body= query values (TitleQuery/BodyQuery, :107-110). */
  titleQuery: string;
  bodyQuery: string;
}

/**
 * `setTemplateIfExists` (issue_new.go:40-96) over the engine reads: the
 * candidate chain is `?template=` FIRST then the 18 fallback paths
 * (IssueTemplateCandidates, routers/web/repo/issue.go:55-73 — appended "to
 * the end because they should be fallback", :50); a missing blob falls
 * through (the util.ErrNotExist continue), a parse error records per file
 * name and falls through too (:58-60), the first success wins and carries
 * the ref normalization (:87-89).
 */
export async function loadNewIssuePrefill(env: Env, repo: NewIssueTemplateRepo, url: URL): Promise<NewIssuePrefill> {
  const templateParam = url.searchParams.get("template");
  const candidates = templateParam !== null && templateParam !== "" ? [templateParam, ...ISSUE_TEMPLATE_CANDIDATES] : [...ISSUE_TEMPLATE_CANDIDATES];
  const templateErrors = new Map<string, string>();
  const reads = engineReads(env, repo);
  const tips = refTipMap(await reads.listRefs());
  const tip = tips.get(branchRef(repo.defaultBranch))?.target ?? null;
  if (tip === null) return { template: null, templateErrors, titleQuery: url.searchParams.get("title") ?? "", bodyQuery: url.searchParams.get("body") ?? "" };
  for (const fileName of candidates) {
    const blob = await reads.readBlob(tip, fileName);
    if (blob === null) continue; // the ErrNotExist arm — the next candidate
    const parsed = unmarshalTemplateBlob(fileName, blob.data);
    if ("error" in parsed) {
      templateErrors.set(fileName, parsed.error);
      continue;
    }
    parsed.template.ref = normalizeRef(parsed.template.ref);
    // The field:{id} query overrides (issue_new.go:66-71): every field (any
    // type — upstream gates on the non-empty value only) gets its
    // attributes.value replaced by the query value.
    for (const field of parsed.template.fields) {
      const fieldValue = url.searchParams.get(`field:${field.id}`);
      if (fieldValue !== null && fieldValue !== "") field.attributes["value"] = fieldValue;
    }
    return {
      template: parsed.template,
      templateErrors,
      titleQuery: url.searchParams.get("title") ?? "",
      bodyQuery: url.searchParams.get("body") ?? "",
    };
  }
  return { template: null, templateErrors, titleQuery: url.searchParams.get("title") ?? "", bodyQuery: url.searchParams.get("body") ?? "" };
}

/** The `template.Ref` normalization shared with the walk (issue_new.go:87-89). */
function normalizeRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

/**
 * The sidebar label prefill (issue_page_meta.go:184-188 + :582-586): the
 * `?label=` (fallback `?labels=`) entries match repo labels by id-or-
 * lowercase-name and TAKE PRECEDENCE; the template's label NAMES match
 * case-insensitively otherwise (SetSelectedLabelNames). Upstream's match
 * map is id-string + lowercased name (`pickItemIDsFromQueryParam`); an
 * unmatched entry matches nothing (it never 404s the page).
 */
export function prefillLabelIds(labels: LabelRow[], templateLabels: string[], queryValue: string | null): number[] {
  const selected: number[] = [];
  if (queryValue !== null && queryValue !== "") {
    for (const key of queryValue.split(",")) {
      const lowered = key.trim().toLowerCase();
      if (lowered === "") continue;
      const label = labels.find((entry) => String(entry.id) === lowered || entry.name.toLowerCase() === lowered);
      if (label !== undefined) selected.push(label.id);
    }
    return selected;
  }
  for (const name of templateLabels) {
    const label = labels.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (label !== undefined) selected.push(label.id);
  }
  return selected;
}

/**
 * `NewIssuePost`'s render arm (issue_new.go:354-359): when `template-file`
 * names a template that re-unmarshals from the DEFAULT branch, the issue
 * body is `RenderToMarkdown(template, form)`; ANY failure (missing file,
 * parse error) leaves the submitted `content` standing silently.
 */
export async function renderSubmittedTemplate(env: Env, repo: NewIssueTemplateRepo, form: NewIssueForm): Promise<string | null> {
  if (form.templateFile === null) return null;
  const reads = engineReads(env, repo);
  const tips = refTipMap(await reads.listRefs());
  const tip = tips.get(branchRef(repo.defaultBranch))?.target ?? null;
  if (tip === null) return null;
  const blob = await reads.readBlob(tip, form.templateFile);
  if (blob === null) return null;
  const parsed = unmarshalTemplateBlob(form.templateFile, blob.data);
  if ("error" in parsed) return null;
  // The native multi-select posts repeated `form-field-{id}` values; the
  // comma-join reproduces the exact bytes upstream's Fomantic dropdown
  // writes into its single hidden input (SPEC §11.3, reduction 2).
  const values: FormValues = {
    get: (name) => {
      const all = form.fieldParams.getAll(name);
      return all.length === 0 ? null : all.join(",");
    },
  };
  return renderTemplateToMarkdown(parsed.template, values);
}

/** Markdown-to-HTML for the field bodies (the issue-detail wrapper's
 *  degrade-to-empty posture; upstream ctx.RenderUtils.MarkdownToHtml with
 *  the repo context for the link rewrites). */
function renderFieldMarkdown(text: string, repo: { ownerNamespace: string; slug: string }, origin: string): string {
  if (text === "") return "";
  try {
    return renderMarkdownToHtml({
      text,
      mode: "comment",
      context: `/${repo.ownerNamespace}/${repo.slug}`,
      wiki: false,
      origin,
    });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The label checkbox group (sidebar/label_list.tmpl reduced to the no-JS
 *  `.ui.checkbox` shape — header comment): one checkbox per repo label, the
 *  upstream `label_ids` multi-value field name. */
function LabelChecklist(props: { data: NewIssueData; selected: number[] }) {
  if (props.data.labels.length === 0) {
    return (
      <div class="issue-sidebar-combo" data-selection-mode="multiple">
        <div class="fixed-text muted">
          <strong>{newIssueLocale.labels}</strong>
        </div>
        <span class="item empty-list">{newIssueLocale.no_labels}</span>
      </div>
    );
  }
  return (
    <div class="issue-sidebar-combo" data-selection-mode="multiple">
      <div class="fixed-text muted">
        <strong>{newIssueLocale.labels}</strong>
      </div>
      <div class="ui list labels-list">
        {props.data.labels.map((label) => {
          const id = `new-issue-label-${label.id}`;
          return (
            <div class="item">
              <div class="ui checkbox">
                <input id={id} name="label_ids" type="checkbox" value={String(label.id)} checked={props.selected.includes(label.id)} />
                <label for={id}>
                  <LabelBadge label={label} />
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The milestone select (the built CSS ships the native
 *  `<select class="ui selection dropdown">` shape — settings/options.tmpl:611
 *  at the pin): open milestones, "No Milestone" the empty default. */
function MilestoneSelect(props: { data: NewIssueData; selected: number | null }) {
  const id = "new-issue-milestone";
  return (
    <div class="issue-sidebar-combo" data-selection-mode="single">
      <div class="field">
        <label for={id} class="fixed-text muted">
          <strong>{newIssueLocale.milestone}</strong>
        </label>
        <select id={id} name="milestone_id" class="ui selection dropdown">
          <option value="">{newIssueLocale.no_milestone}</option>
          {props.data.milestones.map((milestone) => (
            <option value={String(milestone.id)} selected={props.selected === milestone.id}>
              {milestone.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderNewIssuePage(options: {
  ctx: UiContext;
  data: NewIssueData;
  form: NewIssueForm;
  error: string | null;
  /** The yaml-template FIELDS arm (upstream `.Fields`; absent/null or
   *  field-less = the plain textarea). */
  template?: IssueTemplate | null;
  /** The merged invalid-template notices (renderErrorOfTemplates' source —
   *  the GET's discovery + candidate errors, issue_new.go:139-141). */
  templateErrors?: Map<string, string>;
}): string {
  return renderPage(
    <NewIssuePage
      ctx={options.ctx}
      data={options.data}
      form={options.form}
      error={options.error}
      template={options.template}
      templateErrors={options.templateErrors}
    />,
  );
}

/** The field header (fields/header.tmpl): the h3 label with the required
 *  marker unless hide_label, then the markdown description help. */
function TemplateFieldHeader(props: {
  field: IssueFormField;
  repo: { ownerNamespace: string; slug: string };
  origin: string;
}) {
  const label = props.field.attributes["label"];
  const description = props.field.attributes["description"];
  const required = props.field.validations["required"] === true;
  return (
    <>
      {typeof label === "string" && label !== "" && props.field.attributes["hide_label"] !== true ? (
        <h3>
          {label}
          {required ? <label class="required" /> : null}
        </h3>
      ) : null}
      {typeof description === "string" && description !== "" ? (
        <span class="help" dangerouslySetInnerHTML={{ __html: renderFieldMarkdown(description, props.repo, props.origin) }} />
      ) : null}
    </>
  );
}

const stringAttribute = (field: IssueFormField, name: string): string => {
  const value = field.attributes[name];
  return typeof value === "string" ? value : "";
};

/** One template field (fields/{input,markdown,textarea,dropdown,checkboxes}.tmpl
 *  — the native-form reductions per SPEC §11.3; unknown types render nothing,
 *  exactly upstream's eq-chain falling through). */
function TemplateFieldInput(props: {
  field: IssueFormField;
  repo: { ownerNamespace: string; slug: string };
  origin: string;
}) {
  const { field } = props;
  const hiddenClass = visibleOnForm(field) ? "" : " tw-hidden";
  switch (field.type) {
    case "input": {
      const isNumber = field.validations["is_number"] === true;
      const required = field.validations["required"] === true;
      const regex = field.validations["regex"];
      return (
        <div class={`field${hiddenClass}`}>
          <TemplateFieldHeader field={field} repo={props.repo} origin={props.origin} />
          <input
            type={isNumber ? "number" : "text"}
            name={`form-field-${field.id}`}
            placeholder={stringAttribute(field, "placeholder")}
            value={stringAttribute(field, "value")}
            required={required || undefined}
            {...(typeof regex === "string" && regex !== "" ? { pattern: regex, title: regex } : {})}
          />
        </div>
      );
    }
    case "markdown": {
      return (
        <div class={`field${hiddenClass}`}>
          <div class="render-content markup" dangerouslySetInnerHTML={{ __html: renderFieldMarkdown(stringAttribute(field, "value"), props.repo, props.origin) }} />
        </div>
      );
    }
    case "textarea": {
      const required = field.validations["required"] === true;
      return (
        <div class={`field${hiddenClass}`}>
          <TemplateFieldHeader field={field} repo={props.repo} origin={props.origin} />
          <textarea class="form-field-real" name={`form-field-${field.id}`} placeholder={stringAttribute(field, "placeholder")} required={required || undefined}>
            {stringAttribute(field, "value")}
          </textarea>
        </div>
      );
    }
    case "dropdown": {
      const options = Array.isArray(field.attributes["options"]) ? (field.attributes["options"] as unknown[]) : [];
      const multiple = field.attributes["multiple"] === true;
      const defaultValue = field.attributes["default"];
      return (
        <div class={`field${hiddenClass}`}>
          <TemplateFieldHeader field={field} repo={props.repo} origin={props.origin} />
          {/* The native-select reduction (SPEC §11.3, reduction 2): upstream
              posts a Fomantic JS dropdown syncing a hidden input with the
              comma-joined selected indices; the select posts the same
              indices (the POST parser comma-joins repeated values back).
              Upstream's FIXME: dropdown required is NOT enforced — no
              required attribute here either. */}
          <select name={`form-field-${field.id}`} multiple={multiple || undefined} class="ui selection dropdown">
            {options.map((option, index) => (
              <option value={String(index)} selected={defaultValue === index}>
                {typeof option === "string" ? option : ""}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "checkboxes": {
      const options = Array.isArray(field.attributes["options"]) ? (field.attributes["options"] as unknown[]) : [];
      return (
        <div class={`field${hiddenClass}`}>
          <TemplateFieldHeader field={field} repo={props.repo} origin={props.origin} />
          {options.map((option, index) => {
            if (option === null || typeof option !== "object" || Array.isArray(option)) return null;
            const dict = option as Record<string, unknown>;
            const label = dict["label"];
            // hidden when a visible list exists and lacks "form"
            // (checkboxes.tmpl: the and(visible, not contains form) gate)
            const visible = !Array.isArray(dict["visible"]) || dict["visible"].includes("form");
            const required = dict["required"] === true;
            return (
              <div class="field inline">
                <div class={`ui checkbox tw-mr-0${visible ? "" : " tw-hidden"}`}>
                  <input type="checkbox" name={`form-field-${field.id}-${index}`} required={required || undefined} />
                  <label dangerouslySetInnerHTML={{ __html: renderFieldMarkdown(typeof label === "string" ? label : "", props.repo, props.origin) }} />
                </div>
                {required ? <label class="required" /> : null}
              </div>
            );
          })}
        </div>
      );
    }
    default:
      return null;
  }
}

/** The new-issue page (§2.4.1 discriminator: `repository new issue`). */
export function NewIssuePage(props: {
  ctx: UiContext;
  data: NewIssueData;
  form: NewIssueForm;
  error: string | null;
  template?: IssueTemplate | null;
  templateErrors?: Map<string, string>;
}) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("NewIssuePage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const template = props.template ?? null;
  const fieldsArm = template !== null && template.fields.length > 0;
  const templateErrors = props.templateErrors !== undefined && props.templateErrors.size > 0 ? formatTemplateErrors(props.templateErrors) : null;
  return (
    <BaseLayout ctx={ctx} title="New Issue" pageClass="repository new issue" activeTab="issues">
      <div class="ui container">
        {templateErrors !== null ? (
          <div class="ui warning message flash-message flash-warning">
            <div class="text left">
              <div>{issueNewChooseLocale.ignore_invalid_templates}</div>
              <details>
                <summary>{templateErrors.summary}</summary>
                <pre>{templateErrors.details.join("\n")}</pre>
              </details>
            </div>
          </div>
        ) : null}
        <form class="issue-content ui comment form" id="new-issue" action={`${repoLink}/issues/new`} method="post">
          <div class="issue-content-left">
            <div class="ui comments">
              <div class="comment">
                {/* The upstream avatar slot is omitted — no avatar route
                    exists (an <img> to a missing route is a dead link). */}
                <div class="ui segment content tw-my-0 avatar-content-left-arrow">
                  {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
                  <div class="field">
                    <input
                      name="title"
                      data-global-init="autoFocusEnd"
                      id="issue_title"
                      required
                      maxlength={255}
                      autocomplete="off"
                      placeholder={newIssueLocale.title_placeholder}
                      value={form.title}
                    />
                  </div>
                  {fieldsArm ? (
                    <>
                      <input type="hidden" name="template-file" value={template.fileName} />
                      {template.fields.map((field) => (
                        <TemplateFieldInput field={field} repo={repo} origin={ctx.origin} />
                      ))}
                    </>
                  ) : (
                    <div class="field">
                      <textarea id="content" name="content" rows={10} placeholder={newIssueLocale.content_placeholder}>
                        {form.content}
                      </textarea>
                    </div>
                  )}
                  <div class="flex-text-block tw-justify-end">
                    <button type="submit" class="ui primary button">
                      {newIssueLocale.create}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="issue-content-right ui segment">
            <LabelChecklist data={data} selected={form.labelIds} />
            <div class="divider" />
            <MilestoneSelect data={data} selected={form.milestoneId} />
          </div>
        </form>
      </div>
    </BaseLayout>
  );
}
