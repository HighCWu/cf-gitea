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

/** `mail.register_notify.title` (locale_en-US.json): `%[1]s, welcome to %[2]s`. */
export function registerNotifySubject(displayName: string, appName: string): string {
  return `${displayName}, welcome to ${appName}`;
}

/**
 * `templates/mail/base/head.tmpl` — the head verbatim (meta charset,
 * format-detection, color-scheme pair, title, the style block) with the
 * title slot filled by the caller.
 */
function baseHead(titleHtmlEscaped: string): string {
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
	</style>
</head>
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
  const displayName = escapeHtml(data.displayName);
  const dotEscaped = escapeHtml(dotEscape(data.displayName));
  const username = escapeHtml(data.username);
  const appName = escapeHtml(data.appName);
  const appUrl = escapeHtml(data.appUrl);
  const loginUrl = `${appUrl}user/login`;
  const setPwdUrl = `${appUrl}user/forgot_password`;

	return `${baseHead(escapeHtml(registerNotifySubject(dotEscaped, appName)))}
<body>
	<p>Hi <b>${displayName}</b>,</p>
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
   *  (mail_issue_common.go:227-246): "new" | "close" | "reopen" | "comment" |
   *  "ready_for_review" | "merge" | "approve" | "reject" | "review"
   *  (CommentTypeReview's default branch, :248-257) | "default"
   *  (CommentTypeReviewRequest's fall-through, :258-268). */
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
}

/**
 * `templates/mail/repo/issue/default.tmpl` for the new/close/reopen arms —
 * byte-faithful traces of the Go template with `.IsMention` false (pass
 * `isMention` for the mention-batch copies), empty `.ReviewComments`,
 * `.CanReply` false (no incoming email). The `<p>` block
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
  // The IsMention line: `{{if .IsMention}}<p>…</p>{{end}}` — true renders the
  // locale line on the first tab line, false leaves the bare "\t".
  const mentionLine =
    data.isMention === true && data.doerName !== undefined
      ? `\t${issueMentionedYouLine(data.doerName)}`
      : "\t";
  return `${baseHead(title)}
<body>
${mentionLine}
\t
${pBlock}
\t
\t<p><a href="${link}">#${data.issueIndex}</a>.</p>
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
