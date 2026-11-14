/**
 * Mail body templates (specs/email-outbound.md §2.5) — the render half of
 * the upstream pin's mail templates for the surfaces this service has
 * landed, ported as TS functions (upstream renders Go templates from
 * `gitea/templates/mail/**` with the locale strings from
 * `options/locale/locale_en-US.json`; our tree serves English only and has
 * no Go-template runtime, so the strings are pinned verbatim here).
 *
 * This file carries two surfaces:
 *
 *   - `renderRegisterNotify` — `templates/mail/user/auth/register_notify.tmpl`
 *     over `templates/mail/base/head.tmpl` + `footer.tmpl` (the layout
 *     verbatim: the meta/color-scheme head, the style block, the three
 *     locale paragraphs, the `user/login` + `user/forgot_password` links,
 *     the AppUrl footer table).
 *   - `renderIssueCommentMail` — the notify family's landing template:
 *     `templates/mail/repo/issue/default.tmpl` rendered for the plain-comment
 *     arm (action name "comment" — actionToTemplate,
 *     services/mailer/mail_issue_common.go:219-278: "mail/repo/issue/comment"
 *     does not exist upstream either, so the stock render falls through to
 *     default). The same template file serves the additive arms
 *     (new/close/reopen/merge) with different `.ActionName` branches, so the
 *     later surfaces extend this family in place — `renderIssueActionMail`
 *     carries the new/close/reopen branches (the `NewIssue` and
 *     `IssueChangeStatus` receivers, notify.go:53-76) and the comment render
 *     delegates to it (identical bytes — "comment" takes the non-empty-body
 *     branch of the same template).
 *
 * DotEscape (modules/templates/mail.go:41-43) is applied to the display
 * name exactly where the upstream template applies it (the title's
 * `.DisplayName|DotEscape`), and every interpolated user value is
 * HTML-escaped (Go html/template's contextual escaping, reduced to element
 * context — the templates interpolate no attribute/JS contexts).
 */

/** Upstream `dotEscape` (modules/templates/mail.go:41-43). */
export function dotEscape(raw: string): string {
  return raw.replaceAll(".", "\u200d.\u200d");
}

/** Element-context HTML escaping (the reduced Go html/template). */
export function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** `mail.register_notify.title` (locale_en-US.json): `%[1]s, welcome to %[2]s` —
 *  the base head's title line, composed from ALREADY-ESCAPED args (upstream
 *  `TrHTML` escapes each string arg ONCE — localestore.go:156-171 — and the
 *  resulting `template.HTML` inserts raw into `<title>{{.}}</title>`, so the
 *  composition here must NOT re-escape). NOTE this is the TITLE format, not
 *  the email subject: upstream's subject is `TrString("mail.register_notify",
 *  setting.AppName)` = "Welcome to %s" with the AppName only, never the name
 *  (mail_user.go:123) — register-notify.ts's use of this helper as the
 *  subject is a recorded divergence routed to that module's owner. */
export function registerNotifySubject(displayName: string, appName: string): string {
  return `${displayName}, welcome to ${appName}`;
}

/**
 * `templates/mail/base/head.tmpl` — the head verbatim (meta charset,
 * format-detection, color-scheme pair, title, the style block) with the
 * title slot filled by the caller.
 */
function baseHead(titleHtmlEscaped: string, extraHead = ""): string {
  return `<!DOCTYPE html>
<html>
<head>
	<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
	<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
	<meta name="color-scheme" content="light dark">
	<meta name="supported-color-schemes" content="light dark">
	<title>${titleHtmlEscaped}</title>

	<style>
		body {margin: 0; padding: 0}
		body, td {font-family: -apple-system, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Liberation Sans", sans-serif}
		a, a:visited {color: #0969da; text-decoration: none}
		a:hover {text-decoration: underline}
		blockquote {padding-left: 1em; margin: 1em 0; border-left: 1px solid grey}
		@media (prefers-color-scheme: dark) {
			a, a:visited {color: #58a6ff}
			.mail-footer td {border-top-color: #3f4248 !important; color: #8c959f !important}
		}
	</style>${extraHead}</head>
`;
}

/**
 * `templates/mail/base/footer.tmpl` — the footer table verbatim (the AppUrl
 * link + AppName cell over the `mail-footer` styling).
 */
function baseFooter(appUrl: string, appName: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="mail-footer" style="width: 100%; border-collapse: collapse;">
	<tr>
		<td height="16" style="height: 16px; font-size: 0; line-height: 0;">&nbsp;</td>
	</tr>
	<tr>
		<td align="center" style="border-top: 1px solid #d0d7de; color: #59636e; font-size: 12px; padding: 8px 0 0; text-align: center;">
			<a href="${appUrl}">${appName}</a>
		</td>
	</tr>
</table>
`;
}

/** Data for `renderRegisterNotify` (upstream template data map). */
export interface RegisterNotifyData {
  /** Upstream `.DisplayName` — the recipient-facing name (`DisplayName()`:
   *  FullName when set, else the username). */
  displayName: string;
  /** Upstream `.Username`. */
  username: string;
  /** Upstream `AppName` (template funcmap, modules/templates/mail.go:53-55). */
  appName: string;
  /** Upstream `AppUrl` — TRAILING-SLASH form (the template concatenates
   *  `AppUrl + "user/login"` directly). */
  appUrl: string;
}

/**
 * The register-notify body — `templates/mail/user/auth/register_notify.tmpl`
 * with `mail.hi_user_x` ("Hi <b>%s</b>,"), `mail.register_notify.text_1/2/3`
 * and `mail.link_not_working_do_paste` verbatim from
 * `options/locale/locale_en-US.json`.
 */
export function renderRegisterNotify(data: RegisterNotifyData): string {
  const dotEscaped = escapeHtml(dotEscape(data.displayName));
  const username = escapeHtml(data.username);
  const appName = escapeHtml(data.appName);
  const appUrl = escapeHtml(data.appUrl);
  const loginUrl = `${appUrl}user/login`;
  const setPwdUrl = `${appUrl}user/forgot_password`;

	// The head title composes the once-escaped args WITHOUT a second pass
	// (upstream TrHTML escapes each arg once and inserts the template.HTML
	// raw — the previous whole-line re-escape double-escaped any name with
	// markup characters: &amp;lt;b&amp;gt; where upstream has &lt;b&gt;).
	// The body's hi_user_x carries the DotEscaped name per the template's
	// line 9 — BOTH interpolation sites declare the DotEscape pipeline.
	return `${baseHead(registerNotifySubject(dotEscaped, appName))}
<body>
	<p>Hi <b>${dotEscaped}</b>,</p>
	<p>This is your registration confirmation email for ${appName}!</p>
	<p>You can now log in via username: ${username}.</p><p><a href="${loginUrl}">${loginUrl}</a></p>
	<p>If this account has been created for you, please <a href="${setPwdUrl}">set your password</a> first.</p>
	<p>Not working? Try copying and pasting it to your browser.</p>

	${baseFooter(appUrl, appName)}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The notify family (templates/mail/repo/issue/default.tmpl)
// ---------------------------------------------------------------------------

/**
 * `fallbackIssueMailSubject` (services/mailer/mail_issue_common.go:34-36) —
 * `[FullName] Title (#Index)` over `repo.FullName()` ("owner/repo"). The
 * stock default.tmpl carries no subject section (no `---` split,
 * modules/templates/mail.go:119-163), so every comment-arm mail's subject IS
 * this fallback with the `Re: ` prefix applied by the caller when
 * `actName != "new"` (mail_issue_common.go:88-91).
 */
export function issueMailFallbackSubject(repoPath: string, title: string, index: number): string {
  return `[${repoPath}] ${title} (#${index})`;
}

/** Data for `renderIssueCommentMail` (the upstream template data map's used
 *  slice for the comment branch). */
export interface IssueCommentMailData {
  /** Upstream `.Subject` — the compose-time SANITIZED subject
   *  (mail_issue_common.go:127-135: sanitize → IfZero fallback → into the
   *  meta map), html/template-escaped into the head title slot. */
  subject: string;
  /** Upstream `.Body` — the comment content rendered to HTML
   *  (mail_issue_common.go:71-72 RenderString over the repo-comment context
   *  with absolute links); inserted RAW like upstream does. */
  bodyHtml: string;
  /** Upstream `.Link` — Issue.HTMLURL, plus `#issuecomment-<id>` for a
   *  comment mail (`Comment.HashTag`, models/issues/comment.go:554-556). */
  link: string;
  /** Upstream `.Issue.Index`. */
  issueIndex: number;
  /** Upstream `AppName` (the head footer's link text). */
  appName: string;
  /** Upstream `AppUrl` — trailing-slash form. */
  appUrl: string;
}

/**
 * Upstream `User.DisplayNameWithFullName` (models/user/user.go:495-501) —
 * the display name the default.tmpl BODY locale lines interpolate
 * (`.Doer.DisplayNameWithFullName`): `username (FullName)` when a full name
 * is set, else the username. DISTINCT from `fromDisplayName` (mail.go:
 * 157-175, the From header — "FullName (username)", full name first); the
 * body order is pinned by the struct's own Sprintf argument order.
 */
export function displayNameWithFullName(username: string, fullName: string | null): string {
  const trimmed = (fullName ?? "").trim();
  return trimmed === "" ? username : `${username} (${trimmed})`;
}

// The locale action lines (`options/locale/locale_en-US.json`, interpolated
// by default.tmpl with .Doer.DisplayNameWithFullName + .Issue.Index — the
// HTML <b> wrapper is the locale string's own):
//   mail.issue.action.new     = `<b>%[1]s</b> created #%[2]d.`
//   mail.issue.action.close   = `<b>%[1]s</b> closed #%[2]d.`
//   mail.issue.action.reopen  = `<b>%[1]s</b> reopened #%[2]d.`
//   mail.issue.action.ready_for_review = `<b>%[1]s</b> marked this pull
//     request ready for review.`
//   mail.issue.action.approve = `<b>%[1]s</b> approved this pull request.`
//   mail.issue.action.reject  = `<b>%[1]s</b> requested changes on this pull
//     request.`
//   mail.issue.action.review  = `<b>%[1]s</b> commented on this pull
//     request.`
//   mail.issue.x_mentioned_you = `<b>%s</b> mentioned you:` (the IsMention
//     line above the <p> block — .Doer.Name, the RAW username, as the arg).

/** `mail.issue.action.new` — the empty-body branch of the "new" arm. */
export function issueActionNewLine(doerDisplayName: string, issueIndex: number): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> created #${issueIndex}.`;
}

/** `mail.issue.action.close` — the close arm's action line. */
export function issueActionCloseLine(doerDisplayName: string, issueIndex: number): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> closed #${issueIndex}.`;
}

/** `mail.issue.action.reopen` — the reopen arm's action line. */
export function issueActionReopenLine(doerDisplayName: string, issueIndex: number): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> reopened #${issueIndex}.`;
}

/** `mail.issue.action.ready_for_review` — the IssueChangeTitle arm's line
 *  (default.tmpl's first action chain has the branch even though no
 *  `ready_for_review` template file exists — the render falls through to
 *  issue/default like every other named arm). */
export function issueActionReadyForReviewLine(doerDisplayName: string): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> marked this pull request ready for review.`;
}

/** `mail.issue.action.merge` (locale_en-US.json: `<b>%[1]s</b> merged
 *  #%[2]d into %[3]s.`) — the MergePullRequest arm's line: default.tmpl's
 *  merge branch interpolates `.Doer.DisplayNameWithFullName`, `.Issue.Index`
 *  and `.Issue.PullRequest.BaseBranch`. The branch name is a plain-string
 *  locale arg, so it escapes like the display name (TrHTML,
 *  i18n/localestore.go:156-171 — the ready line's precedent). */
export function issueActionMergeLine(doerDisplayName: string, issueIndex: number, baseBranch: string): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> merged #${issueIndex} into ${escapeHtml(baseBranch)}.`;
}

/** `mail.issue.action.approve` — the PullRequestReview arm's line for a
 *  ReviewTypeApprove submit (actionToTemplate's CommentTypeReview branch,
 *  mail_issue_common.go:248-257 — default.tmpl's approve case). */
export function issueActionApproveLine(doerDisplayName: string): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> approved this pull request.`;
}

/** `mail.issue.action.reject` — the ReviewTypeReject line (the reject case). */
export function issueActionRejectLine(doerDisplayName: string): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> requested changes on this pull request.`;
}

/** `mail.issue.action.review` — every other review type's line (the default
 *  case: Comment, and the never-mailed Pending/Request rows). */
export function issueActionReviewLine(doerDisplayName: string): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> commented on this pull request.`;
}

/** `mail.issue.action.review_dismissed` (locale_en-US.json: `<b>%[1]s</b>
 *  dismissed last review from %[2]s for this pull request.`) — the
 *  PullReviewDismiss arm's line (default.tmpl's review_dismissed case,
 *  :39-40): %[1]s is the DISMISSING admin (`.Doer
 *  .DisplayNameWithFullName`), %[2]s the reviewer whose review was
 *  dismissed (`.Comment.Review.Reviewer.DisplayNameWithFullName`). Both
 *  are plain-string locale args — escaped like every line. */
export function issueActionReviewDismissedLine(doerDisplayName: string, reviewerDisplayName: string): string {
  return `<b>${escapeHtml(doerDisplayName)}</b> dismissed last review from ${escapeHtml(reviewerDisplayName)} for this pull request.`;
}

/** `ShortSha` (modules/base/tool.go:31-33) — the first 10 runes. */
export function shortSha(sha: string): string {
  return [...sha].slice(0, 10).join("");
}

/**
 * The push arm's action line (default.tmpl:9-25, the TOP `<p>` block —
 * outside the close/reopen chain). Two shapes, picked by
 * `.Comment.IsForcePush`:
 *   - normal (`mail.issue.action.push_1` / `push_n`, TrN over
 *     `len .Comment.Commits`): `<b>%[1]s</b> pushed %[3]d commit[s] to
 *     %[2]s` — NO trailing period; %[2]s the PR head branch (plain-string
 *     arg, escaped);
 *   - force (`mail.issue.action.force_push`): `<b>%[1]s</b> force-pushed
 *     the <b>%[2]s</b> from %[3]s to %[4]s.` — %[2]s the head branch
 *     (escaped, the <b> wrapper is the locale string's own); %[3]s/%[4]s
 *     are HTMLFormat-built anchors `<a href='URL'><b>SHORTSHA</b></a>`
 *     (template.HTML — passed through the locale render RAW, the assigned
 *     template's anchor precedent), URL = the BASE repo's HTMLURL +
 *     "/commit/" + the full sha.
 */
export function issueActionPushLine(input: {
  doerDisplayName: string;
  headBranch: string;
  repoHtmlUrl: string;
  isForcePush: boolean;
  commitCount: number;
  oldCommit?: string;
  newCommit?: string;
}): string {
  const doer = escapeHtml(input.doerDisplayName);
  const branch = escapeHtml(input.headBranch);
  if (input.isForcePush) {
    const anchor = (sha: string | undefined) =>
      `<a href='${escapeHtml(`${input.repoHtmlUrl}/commit/${sha ?? ""}`)}'><b>${escapeHtml(shortSha(sha ?? ""))}</b></a>`;
    return `<b>${doer}</b> force-pushed the <b>${branch}</b> from ${anchor(input.oldCommit)} to ${anchor(input.newCommit)}.`;
  }
  const noun = input.commitCount === 1 ? "commit" : "commits";
  return `<b>${doer}</b> pushed ${input.commitCount} ${noun} to ${branch}`;
}

/**
 * The push arm's commit list (default.tmpl:61-71, the `<ul>` block below
 * the main `<p>`) — one `<li>` per loaded push commit:
 * `<a href="$repoURL/commit/$sha">SHORTSHA</a> - $MESSAGE_TITLE`. The href
 * is a template-literal interpolation (NOT escaped by the template — the
 * go.sh/HTML contexts differ; the sha is engine-derived hex and the URL
 * the repo's own, so the raw form is upstream's byte shape), the title is
 * `CommitMessage.MessageTitle` (the first line of the trimmed message —
 * the caller threads it, the same derivation) escaped like the display
 * name. Force-push mails carry an EMPTY commit list (the receiver's
 * LoadCommentPushCommits leaves Commits nil for the boundary pair,
 * services/issue/comments.go:168-174) — the block renders the bare
 * `<ul>…</ul>` shell, upstream's own output.
 */
export function issuePushCommitListHtml(repoHtmlUrl: string, commits: Array<{ sha: string; title: string }>): string {
  const items = commits
    .map(
      (commit) =>
        `\t\t\t\n\t\t\t<li>\n\t\t\t\t<a href="${repoHtmlUrl}/commit/${commit.sha}">${escapeHtml(shortSha(commit.sha))}</a> - ${escapeHtml(commit.title)}\n\t\t\t</li>`,
    )
    .join("\n");
  return `\t<ul>\n\t\t\n${items}\n\t\t\n\t\t</ul>`;
}

/** One `.ReviewComments` entry (mail_issue_common.go:93-100's flattened
 *  `Review.CodeComments` — the review's inline code comments). */
export interface ReviewCommentExcerptData {
  /** Upstream `.TreePath` (the in-tree file). */
  treePath: string;
  /** Upstream `.Patch` — the stored diff hunk, RAW inside the `<pre>`. */
  patchHtml: string;
  /** Upstream `.RenderedContent` — the comment content rendered to HTML. */
  contentHtml: string;
}

/**
 * One `{{- range .ReviewComments}}` iteration (default.tmpl:52-59): the
 * `<hr>` + `mail.issue.in_tree_path` ("In %s:") + the patch `<pre>` and
 * the rendered content `<div>`. The leading "\n" and trailing "\t\t" are
 * the range-body boundary trace (L52's newline; L59's leading tabs before
 * `{{end -}}`, whose `-` trims the closing `</p>`'s own indentation —
 * the caller joins iterations directly and appends "</p>" bare).
 */
export function reviewCommentExcerptHtml(excerpt: ReviewCommentExcerptData): string {
  return `\n\t\t\t<hr>\n\t\t\tIn ${escapeHtml(excerpt.treePath)}:\n\t\t\t<div style="padding-left: 1em; margin: 1em 0;">\n\t\t\t\t<pre style="padding: 1em; border-left: 1px solid grey;">${excerpt.patchHtml}</pre>\n\t\t\t\t<div>${excerpt.contentHtml}</div>\n\t\t\t</div>\n\t\t`;
}

/** `mail.issue.x_mentioned_you` — the IsMention batch's line above the <p>
 *  block (`{{if .IsMention}}<p>{{.locale.Tr "mail.issue.x_mentioned_you"
 *  .Doer.Name}}</p>{{end}}`). The arg is `.Doer.Name` — the RAW username,
 *  not the display name — escaped like every plain-string locale arg. */
export function issueMentionedYouLine(doerName: string): string {
  return `<p><b>${escapeHtml(doerName)}</b> mentioned you:</p>`;
}

/** Data for `renderIssueActionMail` (the default.tmpl data map's used slice
 *  for the new/close/reopen arms — the comment twin is IssueCommentMailData). */
export interface IssueActionMailData {
  /** Upstream `.Subject` — the compose-time SANITIZED subject. */
  subject: string;
  /** Upstream `.ActionName` — actionToTemplate's arm name
   *  (mail_issue_common.go:227-262): "new" | "close" | "reopen" | "comment" |
   *  "ready_for_review" | "merge" | "approve" | "reject" | "review"
   *  (CommentTypeReview's default branch, :244-252) | "review_dismissed"
   *  (ActionPullReviewDismissed, :238-239) | "push" (CommentTypePullRequestPush's
   *  default-branch case, :257-258) | "default"
   *  (CommentTypeReviewRequest's fall-through, :259-260). */
  actionName:
    | "new"
    | "close"
    | "reopen"
    | "comment"
    | "ready_for_review"
    | "merge"
    | "approve"
    | "reject"
    | "review"
    | "review_dismissed"
    | "push"
    | "default";
  /** Upstream `.Body` — the content rendered to HTML (the issue content for
   *  "new", emptied by MailParticipants for close/reopen, mail_issue.go:
   *  180-185); "" selects the template's empty-body branch. */
  bodyHtml: string;
  /** The locale action line for the branches that render one — the
   *  close/reopen arms ALWAYS (their first-chain line, independent of the
   *  body) and the "new" arm only when the body is empty (the nested
   *  `{{if eq .ActionName "new"}}`); null = the body branch renders. */
  actionLineHtml: string | null;
  /** Upstream `.Link` — Issue.HTMLURL (no comment anchor — Comment nil). */
  link: string;
  /** Upstream `.Issue.Index`. */
  issueIndex: number;
  /** Upstream `AppName` (the head footer's link text). */
  appName: string;
  /** Upstream `AppUrl` — trailing-slash form. */
  appUrl: string;
  /** Upstream `.IsMention` — the recipient's batch membership (compose's
   *  fromMention, mail_issue.go:101/115: the mention batch mails with it,
   *  the participants batch without). Default (absent/false) renders the
   *  pre-fold dropped-if bytes. */
  isMention?: boolean;
  /** Upstream `.Doer.Name` — the RAW username the mention line interpolates
   *  (default.tmpl's `mail.issue.x_mentioned_you` arg). Required when
   *  isMention is true; ignored otherwise. */
  doerName?: string;
  /** The push arm's TOP action line (default.tmpl:9-25's `<p>` block —
   *  `issueActionPushLine`'s output). Rendered between the mention line
   *  and the main `<p>` when actionName is "push"; absent → the dropped-if
   *  bare-tab line (every other arm). */
  pushLineHtml?: string;
  /** The push arm's commit list (default.tmpl:61-71 —
   *  `issuePushCommitListHtml`'s output, force-push mails carry the bare
   *  shell). Rendered between the main `<p>` and the link line when
   *  actionName is "push"; absent → the dropped-if bare-tab line. */
  pushCommitsHtml?: string;
  /** Upstream `.ReviewComments` — the review's inline code comments
   *  (mail_issue_common.go:93-100, the loaded `Comment.Review.CodeComments`
   *  flatten; empty/absent → the range renders nothing, the pre-fold
   *  bytes). Rendered inside the main `<p>` after the body branch. */
  reviewComments?: ReviewCommentExcerptData[];
  /** Upstream `.CanReply` (mail_issue_common.go:122 —
   *  `setting.IncomingEmail.Enabled && commentType != PullRequestPush`);
   *  true renders the link line's `mail.reply` half
   *  ("or reply to this email directly", default.tmpl:72). Default false —
   *  the pre-fold bytes. */
  canReply?: boolean;
}

/**
 * `templates/mail/repo/issue/default.tmpl` for the new/close/reopen arms —
 * byte-faithful traces of the Go template with `.IsMention` false (pass
 * `isMention` for the mention-batch copies), empty `.ReviewComments`
 * (pass `reviewComments` for the review arm's inline excerpts — the DISMISS arm passes none: upstream's dismiss paths never LoadCodeComments, review.go:372-376/:458-462),
 * `.CanReply` false (pass `canReply` when the inbound arm is up — the
 * link line's "or reply to this email directly" half). The `<p>` block
 * has four reachable shapes (both dropped `{{if}}` lines above it and the
 * second dropped push `{{if}}` below it leave their tab+newline):
 *   - a NON-EMPTY body with no action line (comment, or "new" with content):
 *     the else branch renders it 3-tab indented — the shape
 *     renderIssueCommentMail pinned;
 *   - an action line with an EMPTY body ("close"/"reopen" — their content is
 *     always emptied by MailParticipants; "merge" the same way,
 *     mail_issue.go:184; "ready_for_review" on a description-less pull): the
 *     FIRST action chain emits the locale line 3-tab indented, then the
 *     empty-body branch contributes its two skipped-`{{if}}` lines ("\t\t"
 *     and "\t\t\t") after it;
 *   - an action line AND a non-empty body ("ready_for_review" with a kept
 *     description — MailParticipants' empty list, mail_issue.go:179-185, does
 *     not cover it; upstream the close/reopen arms can never reach this
 *     shape): the line renders 3-tab indented, then the else branch renders
 *     the body 3-tab indented after it;
 *   - "new" with an EMPTY body: the action chain is skipped, and the nested
 *     `{{if eq .ActionName "new"}}` emits its locale line 4-tab indented
 *     after the empty branch's own "\t\t\t" line.
 * The push arm ("push" + `pushLineHtml`/`pushCommitsHtml`) fills the two
 * dropped-if lines with the template's push blocks (its main `<p>` is the
 * no-action-line empty-body shape — the push content is emptied,
 * mail_comment.go:25-27, and the push chain matches no action line).
 * Upstream's `emoji.ReplaceAliases` on the subject is NOT applied (the
 * recorded §8.2 divergence).
 */
export function renderIssueActionMail(data: IssueActionMailData): string {
  const title = escapeHtml(data.subject);
  const link = escapeHtml(data.link);
  // The <p> block per branch — see the shape table in the doc comment (no
  // trailing newline; the skeleton below supplies the line break).
  let pBlock: string;
  if (data.actionLineHtml !== null && data.actionName === "new") {
    pBlock = `\t<p>\n\t\t\n\t\t\t\n\t\t\t\t${data.actionLineHtml}\n\t\t</p>`;
  } else if (data.actionLineHtml !== null && data.bodyHtml !== "") {
    pBlock = `\t<p>\n\t\t\n\t\t\t${data.actionLineHtml}\n\t\t\n\t\t\t${data.bodyHtml}\n\t\t</p>`;
  } else if (data.actionLineHtml !== null) {
    pBlock = `\t<p>\n\t\t\n\t\t\t${data.actionLineHtml}\n\t\t\n\t\t\t\n\t\t</p>`;
  } else {
    pBlock = `\t<p>\n\t\t\n\t\t\t${data.bodyHtml}\n\t\t</p>`;
  }
  // The ReviewComments range (default.tmpl:52-59): each iteration's trace
  // starts with the boundary "\n" and ends with "\t\t" (L59's leading tabs
  // ahead of `{{end -}}`, whose `-` trims the `</p>` line's own indent) —
  // so the shapes' closing "\t\t</p>" becomes "\t\t" + iterations + "</p>".
  // Empty/absent renders nothing (the pre-fold bytes).
  const excerpts = data.reviewComments ?? [];
  if (excerpts.length > 0) {
    pBlock = `${pBlock.slice(0, -"</p>".length)}${excerpts.map(reviewCommentExcerptHtml).join("")}</p>`;
  }
  // The IsMention line: `{{if .IsMention}}<p>…</p>{{end}}` — true renders the
  // locale line on the first tab line, false leaves the bare "\t".
  const mentionLine =
    data.isMention === true && data.doerName !== undefined
      ? `\t${issueMentionedYouLine(data.doerName)}`
      : "\t";
  // The two push blocks (default.tmpl:9-25 and :61-71): keyed on
  // `eq .ActionName "push"` INDEPENDENTLY of the data — only the push arm
  // supplies the html, every other arm leaves the dropped-if bare "\t".
  const pushTopLine = data.actionName === "push" && data.pushLineHtml !== undefined ? `\t${data.pushLineHtml}` : "\t";
  const pushListLine =
    data.actionName === "push" && data.pushCommitsHtml !== undefined ? `\t${data.pushCommitsHtml}` : "\t";
  // The CanReply half (default.tmpl:72): `{{if .CanReply}} {{Tr "mail.reply"}}{{end}}`
  // — the space before "or" is the template literal's own.
  const replyHalf = data.canReply === true ? " or reply to this email directly" : "";
  return `${baseHead(title)}
<body>
${mentionLine}
${pushTopLine}
${pBlock}
${pushListLine}
\t<p><a href="${link}">#${data.issueIndex}</a>${replyHalf}.</p>
\t${baseFooter(data.appUrl, data.appName)}
</body>
</html>`;
}

/**
 * `templates/mail/repo/issue/default.tmpl` for the comment arm — the non-empty
 * body branch of `renderIssueActionMail` (identical bytes: with `.ActionName`
 * "comment" the action chains skip and the else branch renders `.Body`).
 */
export function renderIssueCommentMail(data: IssueCommentMailData): string {
  return renderIssueActionMail({
    subject: data.subject,
    actionName: "comment",
    bodyHtml: data.bodyHtml,
    actionLineHtml: null,
    link: data.link,
    issueIndex: data.issueIndex,
    appName: data.appName,
    appUrl: data.appUrl,
  });
}

// ---------------------------------------------------------------------------
// The assigned mail (templates/mail/repo/issue/assigned.tmpl) — the
// IssueChangeAssignee arm's landing template
// ---------------------------------------------------------------------------

/** Data for `renderIssueAssignedMail` (the assigned.tmpl data map's used
 *  slice). */
export interface IssueAssignedMailData {
  /** Upstream `.Subject` — the compose-time SANITIZED subject. */
  subject: string;
  /** Upstream `.IsPull` — picks the `mail.issue_assigned.pull|issue` line. */
  isPull: boolean;
  /** Upstream `.Doer.DisplayNameWithFullName` (the line's %[1]s). */
  doerDisplayName: string;
  /** Upstream `.Link` — Issue.HTMLURL + `#issuecomment-<id>` (Comment is the
   *  type-9 assignee comment, mail_issue_common.go:56-61; the `%[2]s` arg). */
  link: string;
  /** Upstream `.Issue.Index` (the link text `%d`). */
  issueIndex: number;
  /** Upstream `.Issue.Repo.HTMLURL` (the `%[3]s` arg). */
  repoHtmlUrl: string;
  /** Upstream `.Issue.Repo.FullName` (the repo link's text). */
  repoPath: string;
  /** Upstream `AppName` (the head footer's link text). */
  appName: string;
  /** Upstream `AppUrl` — trailing-slash form. */
  appUrl: string;
}

/**
 * `templates/mail/repo/issue/assigned.tmpl` — byte-faithful trace with
 * `.CanReply` false (no incoming email). The template renders ONLY the locale
 * line — the compose's Content ("Assigned #<index>.") is rendered by
 * composeIssueCommentMessages but this template never prints `.Body`
 * (assigned.tmpl renders `mail.issue_assigned.pull|issue` —
 * locale_en-US.json: `%[1]s assigned you to pull request %[2]s in repository
 * %[3]s.`). The locale line carries NO <b> wrapper (unlike default.tmpl's
 * action lines); the #idx and repo anchors are HTMLFormat-built
 * (modules/templates/helper.go) — template.HTML values that TrHTML passes
 * through raw (i18n/localestore.go:156-171 escapes only plain-string args),
 * with the anchors' arg-escaping done by HTMLFormat and the SINGLE-quoted
 * hrefs being the template literal's own. The blank line + the two dropped
 * variable declarations after `</head>` leave three bare newlines before
 * `<body>`; the dropped `{{if .CanReply}}` leaves its own "\t\n".
 */
export function renderIssueAssignedMail(data: IssueAssignedMailData): string {
  const title = escapeHtml(data.subject);
  const doer = escapeHtml(data.doerDisplayName);
  const link = escapeHtml(data.link);
  const repoUrl = escapeHtml(data.repoHtmlUrl);
  const repoPath = escapeHtml(data.repoPath);
  const line = data.isPull
    ? `${doer} assigned you to pull request <a href='${link}'>#${data.issueIndex}</a> in repository <a href='${repoUrl}'>${repoPath}</a>.`
    : `${doer} assigned you to issue <a href='${link}'>#${data.issueIndex}</a> in repository <a href='${repoUrl}'>${repoPath}</a>.`;
  return `${baseHead(title)}\n\n\n<body>
\t<p>
\t\t
\t\t\t${line}
\t\t
\t</p>
\t
\t${baseFooter(data.appUrl, data.appName)}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The B-65 receiver families (specs/behavioral-census NF10 -> board B-65):
// the three unported mailNotifier receivers' landing templates —
//   - `renderReleaseMail`          — templates/mail/repo/release.tmpl
//   - `renderRepoTransferMail`     — templates/mail/repo/transfer.tmpl
//   - `renderWorkflowRunMail`      — templates/mail/repo/actions/workflow_run.tmpl
// traced byte-for-byte like the families above, with the locale strings
// pinned verbatim from options/locale/locale_en-US.json (our tree serves
// English only).
// ---------------------------------------------------------------------------

/** Go `util.PathEscapeSegments` (modules/util/pathescape.go:14-23): escape
 *  every "/"-separated segment with Go url.PathEscape's rule — RFC 3986
 *  unreserved + the sub-delims and ":@" a path segment may carry stay
 *  literal; everything else percent-encodes (space → %20, never "+"). */
export function pathEscapeSegments(raw: string): string {
  const segmentSafe = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/;
  let out = "";
  for (const ch of raw) {
    if (segmentSafe.test(ch)) {
      out += ch;
    } else {
      out += [...Buffer.from(ch, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    }
  }
  return out.replaceAll("/", "%2F");
}

/** `FormatByteSize` (modules/util/bytesize.go:9-11) = humanize.IBytes —
 *  1024-based units (KiB/MiB/GiB...), one decimal below 10, none at/above
 *  (humanize's default format `%.1f` rounds, `0` renders as `0`):
 *  0→"0", 1023→"1023", 1024→"1.0 KiB", 1536→"1.5 KiB", 1048576→"1.0 MiB". */
export function formatByteSize(size: number): string {
  if (size < 1024) {
    return `${size}`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let value = size;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Go `time.Duration.String()` over whole seconds (the mail jobs' duration
 *  cell — `Stopped.Sub(Started)` rendered by the template verbatim):
 *  "0s", "45s", "1m30s", "2h5m0s", "25h0m0s" — hours never roll into days. */
export function goDurationString(totalSeconds: number): string {
  const seconds = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${secs}s`;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
}

/** `mail.release.new.subject` (locale_en-US.json): `%s in %s released`. */
export function releaseNewSubject(tagName: string, repoPath: string): string {
  return `${tagName} in ${repoPath} released`;
}

/** Data for `renderReleaseMail` (the release.tmpl data map's used slice —
 *  the compose mailNewRelease, mail_release.go:76-119). */
export interface ReleaseMailData {
  /** Upstream `.Subject` — releaseNewSubject(tagName, repoPath). */
  subject: string;
  /** Upstream `.Release.Publisher.Name` — the RAW username the text line's
   *  locale arg carries (mail.release.new.text's %[1]s). */
  publisherName: string;
  /** Upstream `.Release.HTMLURL` — Repo.HTMLURL() + "/releases/tag/" +
   *  PathEscapeSegments(TagName) (models/repo/release.go:145-147). */
  releaseHtmlUrl: string;
  /** Upstream `.Release.TagName`. */
  tagName: string;
  /** Upstream `.Release.Repo.HTMLURL` — the absolute repo URL. */
  repoHtmlUrl: string;
  /** Upstream `.Release.Repo.FullName` — "owner/repo". */
  repoPath: string;
  /** Upstream `.Release.Title`. */
  title: string;
  /** Upstream `.Release.RenderedNote` — the markdown rendered to HTML with
   *  absolute links (renderhelper's WithUseAbsoluteLink(true) arm); RAW in
   *  the div. "" takes the template's dropped-if line. */
  renderedNoteHtml: string;
  /** Upstream `.Release.Attachments` — DownloadURL + Name + Size per row. */
  attachments: Array<{ downloadUrl: string; name: string; size: number }>;
  /** Upstream `AppName` (the head footer's link text). */
  appName: string;
  /** Upstream `AppUrl` — trailing-slash form. */
  appUrl: string;
}

/**
 * `templates/mail/repo/release.tmpl` — byte-faithful trace. The source
 * archive rows render unconditionally (upstream `.DisableDownloadSourceArchives`
 * is a mail-template-level flag wired from the repo units; no producer on
 * this tree sets it — the template's `{{if not}}` default arm). Empty
 * RenderedNote renders the dropped-if bare-tab line. Attachment URLs are
 * interpolated RAW (`{{.DownloadURL}}` attribute context — the value is our
 * canonical `/attachments/{uuid}` absolute, MakeAbsoluteURL's shape).
 */
export function renderReleaseMail(data: ReleaseMailData): string {
  const subject = escapeHtml(data.subject);
  const publisher = escapeHtml(data.publisherName);
  const tag = escapeHtml(data.tagName);
  const releaseUrl = escapeHtml(data.releaseHtmlUrl);
  const repoUrl = escapeHtml(data.repoHtmlUrl);
  const repoPath = escapeHtml(data.repoPath);
  const title = escapeHtml(data.title);
  const textLine = `<b>${publisher}</b> released <a href='${releaseUrl}'>${tag}</a> in <a href='${repoUrl}'>${repoPath}</a>`;
  const noteLine = data.renderedNoteHtml === "" ? "" : `<div>${data.renderedNoteHtml}</div>`;
  const zipUrl = `${data.repoHtmlUrl}/archive/${pathEscapeSegments(data.tagName)}.zip`;
  const targzUrl = `${data.repoHtmlUrl}/archive/${pathEscapeSegments(data.tagName)}.tar.gz`;
  const attachmentItems = data.attachments
    .map(
      (attachment) =>
        `\t\t\t<li>\n\t\t\t\t<a target="_blank" href="${escapeHtml(attachment.downloadUrl)}"><strong>${escapeHtml(attachment.name)} (${escapeHtml(formatByteSize(attachment.size))})</strong></a>\n\t\t\t</li>`,
    )
    .join("\n");
  return `${baseHead(subject)}

<body>
	<p>
		${textLine}
	</p>
	<h4>Title: ${title}</h4>
	<p>Note:</p>
	${noteLine}
	<p>Downloads:</p>
	<ul>
		<li>
			<a href="${escapeHtml(zipUrl)}" rel="nofollow"><strong>Source Code (ZIP)</strong></a>
		</li>
		<li>
			<a href="${escapeHtml(targzUrl)}" rel="nofollow"><strong>Source Code (TAR.GZ)</strong></a>
		</li>${attachmentItems === "" ? "" : `\n${attachmentItems}`}
	</ul>
	${baseFooter(data.appUrl, data.appName)}
</body>
</html>`;
}

/** `mail.repo.transfer.subject_to_you` (locale_en-US.json): `%s would like
 *  to transfer "%s" to you` — the USER-target arm's subject (doer display
 *  name + repo full name). */
export function repoTransferSubjectToYou(doerDisplayName: string, repoPath: string): string {
  return `${doerDisplayName} would like to transfer "${repoPath}" to you`;
}

/** `mail.repo.transfer.subject_to`: `%s would like to transfer "%s" to %s` —
 *  the ORG-target arm's subject (destination = the org's display name). */
export function repoTransferSubjectTo(doerDisplayName: string, repoPath: string, destination: string): string {
  return `${doerDisplayName} would like to transfer "${repoPath}" to ${destination}`;
}

/** Data for `renderRepoTransferMail` (transfer.tmpl's data map). */
export interface RepoTransferMailData {
  /** Upstream `.Subject` — the arm's composed subject (to_you / to). */
  subject: string;
  /** Upstream `.Link` — Repo.HTMLURL (the transfer landing URL). */
  link: string;
  /** Upstream `.Repo` — the repo full name (the anchor's text). */
  repoPath: string;
  /** Upstream `AppName` (the head footer's link text). */
  appName: string;
  /** Upstream `AppUrl` — trailing-slash form. */
  appUrl: string;
}

/**
 * `templates/mail/repo/transfer.tmpl` — byte-faithful trace. The subject is
 * interpolated TWICE (the head title arg AND the body's first line — the
 * template's own shape, `{{.Subject}}.` with the trailing period literal);
 * the body line is `mail.repo.transfer.body` = "To accept or reject it,
 * visit %s or just ignore it." with the HTMLFormat-built anchor raw.
 */
export function renderRepoTransferMail(data: RepoTransferMailData): string {
  const subject = escapeHtml(data.subject);
  const link = escapeHtml(data.link);
  const repoPath = escapeHtml(data.repoPath);
  return `${baseHead(subject)}

<body>
	<p>${subject}.
		To accept or reject it, visit <a href='${link}'>${repoPath}</a> or just ignore it.
	</p>
	${baseFooter(data.appUrl, data.appName)}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The actions workflow-run family (templates/mail/repo/actions/workflow_run.tmpl)
// ---------------------------------------------------------------------------

/** Upstream `Status.LocaleString` (models/actions/status.go:48-50 → the
 *  `actions.status.*` locale strings) over the run/job status enum — the
 *  subject's status word and the job icons' alt text. Our numeric enum is
 *  models/actions/status.go's (ACTION_STATUS_* in services/actions/model.ts):
 *  0 unknown 1 success 2 failure 3 cancelled 4 skipped. */
export function actionStatusLocaleString(status: number): string {
  switch (status) {
    case 0:
      return "Unknown";
    case 1:
      return "Success";
    case 2:
      return "Failure";
    case 3:
      return "Canceled";
    case 4:
      return "Skipped";
    default:
      return "Unknown";
  }
}

/** Upstream `workflowRunJobStatusPresentation` (mail_workflow_run.go:49-59):
 *  success → status-success, cancelled/skipped → status-neutral, everything
 *  else → status-failure. */
export function workflowRunJobStatusClass(status: number): "status-success" | "status-neutral" | "status-failure" {
  if (status === 1) return "status-success";
  if (status === 3 || status === 4) return "status-neutral";
  return "status-failure";
}

/** One mail job row (upstream `workflowRunMailJob`, mail_workflow_run.go:34-43,
 *  minus the embedded-icon fields — see the PLATFORM note on
 *  `renderWorkflowRunMail`). */
export interface WorkflowRunMailJob {
  htmlUrl: string;
  name: string;
  status: number;
  attempt: number;
  /** Whole seconds (Go time.Duration rendered by String()). */
  durationSeconds: number;
}

/** Data for `renderWorkflowRunMail` (workflow_run.tmpl's data map). */
export interface WorkflowRunMailData {
  /** Upstream `.Subject` — the composed subject (workflowRunSubject). */
  subject: string;
  /** Upstream `.Jobs` — the latest-attempt jobs, failures-first sorted by
   *  the compose; empty renders the else arm. */
  jobs: WorkflowRunMailJob[];
  /** Upstream `.Run.HTMLURL` — the else arm's link (run landing URL). */
  runHtmlUrl: string;
  /** Upstream `.Run.WorkflowID` — the else arm's text. */
  workflowId: string;
  /** Upstream `AppName` (the head footer's link text). */
  appName: string;
  /** Upstream `AppUrl` — trailing-slash form. */
  appUrl: string;
}

/** The workflow_run.tmpl `<head>`'s own style block (verbatim — it sits
 *  AFTER the base head include, INSIDE the same `<head>`). */
const WORKFLOW_RUN_HEAD_STYLE = `
	<style>
		.job-row td {border-top: 1px solid #d0d7de}
		a.status-success {color: #2da44e !important}
		a.status-failure {color: #e5534b !important}
		a.status-neutral, .job-duration {color: #697077 !important}
		img.status-neutral {filter: brightness(75%)}
		@media (prefers-color-scheme: dark) {
			.job-row td {border-top-color: #3f4248}
			a.status-neutral, .job-duration {color: #afbac7 !important}
			img.status-neutral {filter: brightness(125%)}
		}
	</style>`;

/**
 * `templates/mail/repo/actions/workflow_run.tmpl` — byte-faithful trace with
 * ONE recorded PLATFORM reduction: the status-icon `<td>` (an embedded PNG
 * served by `cid:` content-id — mail_workflow_run.go:98-110 LoadMailIcon +
 * the iconsFS embed) has no carrier in the outbox draft shape (no
 * multipart/related embeds), so the icon cell is DROPPED per row and the
 * status word rides the hidden `<span>` the alt text fed (visually the
 * status stays conveyed by the colored link class + the subject's status
 * word; the `img.*` style rules stay in the block — dead bytes, kept for
 * the trace). The `{{if gt $job.Attempt 1}}` line renders its "(Attempt
 * #N)" parens or its bare tab+newline; the duration cell keeps the hidden
 * `<br>` spacer byte.
 */
export function renderWorkflowRunMail(data: WorkflowRunMailData): string {
  const subject = escapeHtml(data.subject);
  const rows: string[] = [];
  for (const [index, job] of data.jobs.entries()) {
    const cls = workflowRunJobStatusClass(job.status);
    const statusWord = escapeHtml(actionStatusLocaleString(job.status));
    const attemptLine = job.attempt > 1 ? `(Attempt #${job.attempt})` : "";
    rows.push(
      `\t\t<tr${index === 0 ? "" : ` class="job-row"`}>\n` +
        // PLATFORM: the icon <td> dropped (the cid embed reduction above).
        `\t\t\t<td align="left" style="padding: 6px 0; text-align: left; vertical-align: middle; word-break: break-word;">\n` +
        `\t\t\t\t<a class="${cls}" href="${escapeHtml(job.htmlUrl)}" style="font-weight: bold;"><span style="display: none;">${statusWord}: </span>${escapeHtml(job.name)}</a>\n` +
        `\t\t\t\t${attemptLine}\n` +
        `\t\t\t</td>\n` +
        `\t\t\t<td class="job-duration" width="1%" align="right" style="width: 1%; padding: 6px 0 6px 8px; text-align: right; vertical-align: middle; white-space: nowrap;">${escapeHtml(goDurationString(job.durationSeconds))}<span style="display: none;"><br></span></td>\n` +
        `\t\t</tr>`,
    );
  }
  const jobsBlock =
    data.jobs.length > 0
      ? `\t\n\t<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width: 100%; border-collapse: collapse;">\n\t\n${rows.join("\n")}\n\t\n\t</table>\n\t\n`
      : `\t\n\t<p><a href="${escapeHtml(data.runHtmlUrl)}">${escapeHtml(data.workflowId)}</a></p>\n\t\n`;
  return `${baseHead(subject, WORKFLOW_RUN_HEAD_STYLE)}
<body>

	<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 0 8px;">
${jobsBlock}	</td></tr></table>

	${baseFooter(data.appUrl, data.appName)}

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The team invite (templates/mail/org/team_invite.tmpl — census B-77)
// ---------------------------------------------------------------------------

/** `mail.team_invite.subject` (locale_en-US.json): `%[1]s has invited you to
 *  join the %[2]s organization`. NOTE the caller applies NO DotEscape here —
 *  mail_team_invite.go:42 interpolates the raw DisplayName() pair (the body's
 *  text_1 is where the template DotEscapes). */
export function teamInviteSubject(inviterDisplayName: string, orgDisplayName: string): string {
  return `${inviterDisplayName} has invited you to join the ${orgDisplayName} organization`;
}

/** Data for `renderTeamInviteMail` (team_invite.tmpl's data map). */
export interface TeamInviteMailData {
  /** Upstream `.Inviter.DisplayName()` — DotEscape + escape applied at the
   *  text_1 interpolation, the template's exact order. */
  inviterDisplayName: string;
  /** Upstream `.Team.Name` — same treatment. */
  teamName: string;
  /** Upstream `.Organization.DisplayName()` — same treatment. */
  orgDisplayName: string;
  /** Upstream `.InviteURL` — rendered verbatim (never escaped: the template
   *  interpolates it as the href AND the link text raw). */
  inviteUrl: string;
  /** Upstream `.Invite.Email` — text_3's intended-for note. */
  inviteEmail: string;
  /** Upstream AppUrl — TRAILING-SLASH form (the footer concatenates). */
  appUrl: string;
  /** Upstream AppName (template funcmap) — the footer link's label. */
  appName: string;
}

/**
 * The team invite body — `templates/mail/org/team_invite.tmpl` over the base
 * head/footer: `mail.team_invite.text_1` ("%[1]s has invited you to join team
 * %[2]s in organization %[3]s.", the three names DotEscaped per the template's
 * `(DotEscape …)` pipeline), `mail.team_invite.text_2`, the break-all link
 * paragraph, `mail.link_not_working_do_paste` and `mail.team_invite.text_3`
 * ("Note: This invitation was intended for %[1]s. …") verbatim from
 * locale_en-US.json.
 */
export function renderTeamInviteMail(data: TeamInviteMailData): string {
  const inviter = escapeHtml(dotEscape(data.inviterDisplayName));
  const team = escapeHtml(dotEscape(data.teamName));
  const org = escapeHtml(dotEscape(data.orgDisplayName));
  const email = escapeHtml(data.inviteEmail);
  const subject = escapeHtml(teamInviteSubject(data.inviterDisplayName, data.orgDisplayName));
  return `${baseHead(subject)}
<body>
	<p>${inviter} has invited you to join team ${team} in organization ${org}.</p>
	<p>Please click the following link to join the team:</p><p style="word-break: break-all;"><a href="${data.inviteUrl}">${data.inviteUrl}</a></p>
	<p>Not working? Try copying and pasting it to your browser.</p>
	<p>Note: This invitation was intended for ${email}. If you were not expecting this invitation, you can ignore this email.</p>

	${baseFooter(data.appUrl, data.appName)}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The password-reset mail (templates/mail/user/auth/reset_passwd.tmpl —
// census B-84, the forgot-REQUEST arm's carrier)
// ---------------------------------------------------------------------------

/** Go `url.QueryEscape` (net/url, the template funcmap's QueryEscape):
 *  space becomes "+", every byte outside the unreserved set
 *  (`A-Za-z0-9-._~`) percent-encodes UPPERCASE. The reset code's alphabet is
 *  digits + hex + the hex(lowerName) tail — all unreserved, so the helper is
 *  identity on every real value; it exists because the template's printf
 *  pipeline runs it unconditionally. */
export function goQueryEscape(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === " ") {
      out += "+";
    } else {
      out += [...Buffer.from(ch, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    }
  }
  return out;
}

/** `mail.reset_password` (locale_en-US.json) — the EMAIL SUBJECT, verbatim
 *  with no interpolation (mail_user.go:69's `TrString`, unlike the title line
 *  below it carries no arg). The MAIL_SUBJECT_PREFIX rides at SEND time
 *  (message.ts), never in the stored draft. */
export function resetPasswordMailSubject(): string {
  return "Recover your account";
}

/** `mail.reset_password.title` (locale_en-US.json): `%s, you have requested
 *  to recover your account` — the base head's title line. The arg is the
 *  DotEscape'd display name; TrHTML escapes plain-string args ONCE
 *  (localestore.go:156-171) and the template.HTML result inserts raw into
 *  `<title>{{.}}</title>` — so the caller passes the ALREADY-ESCAPED name and
 *  this composes without a second pass (the register_notify twin composes
 *  the same way — the former whole-line re-escape there was the routed
 *  B-84 defect, fixed in renderRegisterNotify). */
export function resetPasswordMailTitle(escapedDotEscapedDisplayName: string): string {
  return `${escapedDotEscapedDisplayName}, you have requested to recover your account`;
}

/** Data for `renderResetPasswordMail` (sendUserMail's data map's used slice,
 *  mail_user.go:29-37). */
export interface ResetPasswordMailData {
  /** Upstream `.DisplayName` — DotEscape'd at BOTH interpolation sites the
   *  template declares (the head title arg AND mail.hi_user_x's). */
  displayName: string;
  /** Upstream `.ResetPwdCodeLives` — the friendly minutes string
   *  (MinutesToFriendly(180) = "3 hours"). */
  resetPwdCodeLives: string;
  /** Upstream `.Code` — the time-limit code (code + the hex tail, verbatim;
   *  QueryEscape is identity on its alphabet, see goQueryEscape). */
  code: string;
  /** Upstream AppUrl — TRAILING-SLASH form (the template's printf
   *  concatenates `AppUrl + "user/recover_account?code="` directly). */
  appUrl: string;
  /** Upstream AppName (template funcmap) — the footer link's label. */
  appName: string;
}

/**
 * The password-reset body — `templates/mail/user/auth/reset_passwd.tmpl`
 * byte-faithful trace over the base head/footer. The recover URL points at
 * `user/recover_account` (NOT reset_password — both routes bind the SAME
 * handlers upstream, web.go:761-762), interpolated RAW into the href AND the
 * link text (the register_notify/team_invite URL precedent — html/template's
 * href-context escaping is identity for this scheme+path+single-query form).
 * The `mail.reset_password.text` line and its link paragraph share ONE
 * source line (the template's own adjacency, like register_notify's text_2).
 */
export function renderResetPasswordMail(data: ResetPasswordMailData): string {
  const dotEscaped = escapeHtml(dotEscape(data.displayName));
  const lives = escapeHtml(data.resetPwdCodeLives);
  const appUrl = escapeHtml(data.appUrl);
  const appName = escapeHtml(data.appName);
  const recoverUrl = `${data.appUrl}user/recover_account?code=${goQueryEscape(data.code)}`;
  return `${baseHead(resetPasswordMailTitle(dotEscaped))}
<body>
	<p>Hi <b>${dotEscaped}</b>,</p>
	<p>Please click the following link to recover your account within <b>${lives}</b>:</p><p style="word-break: break-all;"><a href="${recoverUrl}">${recoverUrl}</a></p>
	<p>Not working? Try copying and pasting it to your browser.</p>

	${baseFooter(appUrl, appName)}
</body>
</html>`;
}
