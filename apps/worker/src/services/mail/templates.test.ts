/**
 * The register-notify template render (services/mail/templates.ts) — pinned
 * against the pin's own strings: `mail.register_notify.title/.text_1/.text_2/
 * .text_3` and `mail.hi_user_x` verbatim from
 * gitea/options/locale/locale_en-US.json, the layout of
 * templates/mail/user/auth/register_notify.tmpl over mail/base/{head,footer}.
 */

import { describe, expect, it } from "vitest";

import {
  displayNameWithFullName,
  dotEscape,
  escapeHtml,
  issueActionCloseLine,
  issueActionNewLine,
  issueActionReopenLine,
  registerNotifySubject,
  renderIssueActionMail,
  renderIssueCommentMail,
  renderRegisterNotify,
} from "./templates";

describe("locale-string pins", () => {
  it("mail.register_notify.title — '%[1]s, welcome to %[2]s'", () => {
    expect(registerNotifySubject("Alice", "Gitea")).toBe("Alice, welcome to Gitea");
  });
});

describe("dotEscape (modules/templates/mail.go:41-43)", () => {
  it("wraps dots with U+200D", () => {
    expect(dotEscape("a.b.c")).toBe("a\u200d.\u200db\u200d.\u200dc");
  });
});

describe("escapeHtml", () => {
  it("escapes the five markup characters", () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });
});

describe("renderRegisterNotify (register_notify.tmpl layout)", () => {
  const render = () =>
    renderRegisterNotify({
      displayName: "Alice",
      username: "alice",
      appName: "Gitea",
      appUrl: "https://g.example/",
    });

  it("carries the four locale paragraphs verbatim", () => {
    const html = render();
    expect(html).toContain("<p>Hi <b>Alice</b>,</p>");
    expect(html).toContain("<p>This is your registration confirmation email for Gitea!</p>");
    expect(html).toContain("<p>You can now log in via username: alice.</p>");
    expect(html).toContain(
      "<p>If this account has been created for you, please <a href=\"https://g.example/user/forgot_password\">set your password</a> first.</p>",
    );
    expect(html).toContain("<p>Not working? Try copying and pasting it to your browser.</p>");
  });

  it("links AppUrl + user/login (the template's direct concatenation)", () => {
    expect(render()).toContain(
      '<a href="https://g.example/user/login">https://g.example/user/login</a>',
    );
  });

  it("puts the title in <title>, DotEscaped where the template applies it", () => {
    expect(render()).toContain("<title>Alice, welcome to Gitea</title>");
    const dotted = renderRegisterNotify({
      displayName: "Al.ice",
      username: "alice",
      appName: "Gitea",
      appUrl: "https://g.example/",
    });
    expect(dotted).toContain(`<title>Al\u200d.\u200dice, welcome to Gitea</title>`);
    // ...and the DOT-ESCAPED form appears ONLY in the title (the body
    // paragraphs use the raw DisplayName, per the template).
    expect(dotted).toContain("<p>Hi <b>Al.ice</b>,</p>");
  });

  it("renders the base footer's AppUrl + AppName cell", () => {
    expect(render()).toContain('<a href="https://g.example/">Gitea</a>');
    expect(render()).toContain('class="mail-footer"');
  });

  it("HTML-escapes user-controlled values everywhere", () => {
    const hostile = renderRegisterNotify({
      displayName: "<b>Eve</b> & Sons",
      username: 'x"y',
      appName: "Gitea",
      appUrl: "https://g.example/",
    });
    expect(hostile).toContain("<p>Hi <b>&lt;b&gt;Eve&lt;/b&gt; &amp; Sons</b>,</p>");
    expect(hostile).toContain("username: x&quot;y.");
    expect(hostile).not.toContain("<b>Eve</b> & Sons");
  });
});

// ---------------------------------------------------------------------------
// The action arms — default.tmpl's new/close/reopen branches
// (services/mailer/mail_issue_common.go:227-246's names over
// templates/mail/repo/issue/default.tmpl; no mail/repo/issue/new|close|
// reopen template exists at the pin, so every arm renders default.tmpl)
// ---------------------------------------------------------------------------

describe("displayNameWithFullName (models/user/user.go:495-501)", () => {
  it("is 'username (FullName)' when set — USERNAME first, the Sprintf argument order", () => {
    expect(displayNameWithFullName("user2", "Mister X")).toBe("user2 (Mister X)");
  });
  it("is the bare username otherwise (and trims the full name first)", () => {
    expect(displayNameWithFullName("user2", "")).toBe("user2");
    expect(displayNameWithFullName("user2", null)).toBe("user2");
    expect(displayNameWithFullName("user2", "   ")).toBe("user2");
  });
  it("is DISTINCT from mail.go's fromDisplayName, which is FullName first", () => {
    // mail.go:157-175's fallback builds FullName + " (" + Name + ")"; the
    // body templates interpolate the user.go order. Both are pinned; this
    // helper is the body one.
    expect(displayNameWithFullName("tmp", "Mister X")).toBe("tmp (Mister X)");
    expect(displayNameWithFullName("tmp", "Mister X")).not.toBe("Mister X (tmp)");
  });
});

describe("locale action lines (options/locale/locale_en-US.json)", () => {
  it("mail.issue.action.new — '<b>%[1]s</b> created #%[2]d.'", () => {
    expect(issueActionNewLine("user2 (Mister X)", 1)).toBe("<b>user2 (Mister X)</b> created #1.");
  });
  it("mail.issue.action.close — '<b>%[1]s</b> closed #%[2]d.'", () => {
    expect(issueActionCloseLine("user2", 3)).toBe("<b>user2</b> closed #3.");
  });
  it("mail.issue.action.reopen — '<b>%[1]s</b> reopened #%[2]d.'", () => {
    expect(issueActionReopenLine("user2", 3)).toBe("<b>user2</b> reopened #3.");
  });
  it("escapes the interpolated display name (html/template element context)", () => {
    expect(issueActionCloseLine('<b>Eve</b> & Sons', 1)).toBe(
      "<b>&lt;b&gt;Eve&lt;/b&gt; &amp; Sons</b> closed #1.",
    );
  });
});

describe("renderIssueActionMail — default.tmpl non-comment branches", () => {
  const render = (over: Partial<Parameters<typeof renderIssueActionMail>[0]> = {}) =>
    renderIssueActionMail({
      subject: "Re: [user2/repo1] issue1 (#1)",
      actionName: "close",
      bodyHtml: "",
      actionLineHtml: issueActionCloseLine("user2", 1),
      link: "https://x.example/user2/repo1/issues/1",
      issueIndex: 1,
      appName: "Gitea",
      appUrl: "https://x.example/",
      ...over,
    });

  it("close arm: the locale line rides the FIRST action chain, the empty-body branch leaves its two skipped-if lines after it", () => {
    const html = render();
    // Byte trace of default.tmpl for ActionName "close" with .Body "":
    // "\t<p>\n" + "\t\t\n" (skipped close-chain if) + "\t\t\t" + locale +
    // "\t\t\n" (empty-branch's leading text) + "\t\t\t\n" (the nested
    // {{if new}} skipped area) + "\t\t</p>".
    expect(html).toContain(
      "<body>\n\t\n\t\n\t<p>\n\t\t\n\t\t\t<b>user2</b> closed #1.\n\t\t\n\t\t\t\n\t\t</p>\n\t\n\t<p><a href=\"https://x.example/user2/repo1/issues/1\">#1</a>.</p>\n\t<table",
    );
    expect(html).toContain("<title>Re: [user2/repo1] issue1 (#1)</title>");
    expect(html).toContain('<a href="https://x.example/">Gitea</a>');
  });

  it("reopen arm: the same shape with the reopened locale line", () => {
    const html = render({
      actionName: "reopen",
      actionLineHtml: issueActionReopenLine("user2", 1),
    });
    expect(html).toContain(
      "\t<p>\n\t\t\n\t\t\t<b>user2</b> reopened #1.\n\t\t\n\t\t\t\n\t\t</p>\n",
    );
  });

  it("new arm with an EMPTY body: the locale line rides the nested new-if, 4-tab indented after the empty branch's own line", () => {
    const html = render({
      subject: "[user2/repo1] issue1 (#1)",
      actionName: "new",
      actionLineHtml: issueActionNewLine("user2", 1),
    });
    expect(html).toContain(
      "\t<p>\n\t\t\n\t\t\t\n\t\t\t\t<b>user2</b> created #1.\n\t\t</p>\n",
    );
    expect(html).toContain("<title>[user2/repo1] issue1 (#1)</title>");
  });

  it("new arm with a body: identical bytes to the comment arm's else-branch shape", () => {
    const body = "<p>a fresh description</p>\n";
    const action = renderIssueActionMail({
      subject: "[user2/repo1] issue1 (#1)",
      actionName: "new",
      bodyHtml: body,
      actionLineHtml: null,
      link: "https://x.example/user2/repo1/issues/1",
      issueIndex: 1,
      appName: "Gitea",
      appUrl: "https://x.example/",
    });
    const comment = renderIssueCommentMail({
      subject: "[user2/repo1] issue1 (#1)",
      bodyHtml: body,
      link: "https://x.example/user2/repo1/issues/1",
      issueIndex: 1,
      appName: "Gitea",
      appUrl: "https://x.example/",
    });
    expect(action).toBe(comment);
    expect(action).toContain("\t<p>\n\t\t\n\t\t\t<p>a fresh description</p>\n\n\t\t</p>\n");
  });
});
