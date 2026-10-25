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
 * - Issue templates (`.Fields` / `.gitea` template files) are not offered —
 *   no template-file pipeline exists.
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
  return {
    title: (params.get("title") ?? "").trim(),
    content: params.get("content") ?? "",
    labelIds,
    milestoneId,
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
}): string {
  return renderPage(<NewIssuePage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />);
}

/** The new-issue page (§2.4.1 discriminator: `repository new issue`). */
export function NewIssuePage(props: { ctx: UiContext; data: NewIssueData; form: NewIssueForm; error: string | null }) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("NewIssuePage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title="New Issue" pageClass="repository new issue" activeTab="issues">
      <div class="ui container">
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
                  <div class="field">
                    <textarea id="content" name="content" rows={10} placeholder={newIssueLocale.content_placeholder}>
                      {form.content}
                    </textarea>
                  </div>
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
