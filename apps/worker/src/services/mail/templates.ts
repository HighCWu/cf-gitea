/**
 * Mail body templates (specs/email-outbound.md §2.5) — the render half of
 * the upstream pin's mail templates for the surfaces this service has
 * landed, ported as TS functions (upstream renders Go templates from
 * `gitea/templates/mail/**` with the locale strings from
 * `options/locale/locale_en-US.json`; our tree serves English only and has
 * no Go-template runtime, so the strings are pinned verbatim here).
 *
 * This file carries the first surface only:
 *
 *   - `renderRegisterNotify` — `templates/mail/user/auth/register_notify.tmpl`
 *     over `templates/mail/base/head.tmpl` + `footer.tmpl` (the layout
 *     verbatim: the meta/color-scheme head, the style block, the three
 *     locale paragraphs, the `user/login` + `user/forgot_password` links,
 *     the AppUrl footer table).
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
