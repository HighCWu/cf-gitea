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
  issueActionApproveLine,
  issueActionCloseLine,
  issueActionNewLine,
  issueActionMergeLine,
  issueActionPushLine,
  issueActionReadyForReviewLine,
  issueActionRejectLine,
  issueActionReopenLine,
  issueActionReviewDismissedLine,
  issueActionReviewLine,
  issuePushCommitListHtml,
  registerNotifySubject,
  renderIssueActionMail,
  renderIssueAssignedMail,
  renderIssueCommentMail,
  renderRegisterNotify,
  shortSha,
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

  it("ready_for_review with a KEPT description: the ready line AND the body render (MailParticipants keeps the content, mail_issue.go:179-185)", () => {
    const html = render({
      actionName: "ready_for_review",
      actionLineHtml: issueActionReadyForReviewLine("user2"),
      bodyHtml: "<p>the description</p>\n",
    });
    // The line rides the FIRST chain 3-tab indented; the else branch renders
    // the body 3-tab indented after it (the `{{- if}}` trims the whitespace
    // between {{end}} and the body branch — mail_issue_common.go's compose).
    expect(html).toContain(
      "\t<p>\n\t\t\n\t\t\t<b>user2</b> marked this pull request ready for review.\n\t\t\n\t\t\t<p>the description</p>\n\n\t\t</p>\n",
    );
  });

  it("ready_for_review with an EMPTY body: byte-identical to the close/reopen shape", () => {
    const ready = render({
      actionName: "ready_for_review",
      actionLineHtml: issueActionReadyForReviewLine("user2"),
    });
    const close = render();
    // The only difference is the line itself — the surrounding whitespace is
    // the shared first-chain + empty-branch trace.
    expect(ready.replace("marked this pull request ready for review.", "closed #1.")).toBe(close);
  });
});

describe("issueActionReadyForReviewLine (mail.issue.action.ready_for_review)", () => {
  it("'<b>%[1]s</b> marked this pull request ready for review.' — no index argument", () => {
    expect(issueActionReadyForReviewLine("user2 (Mister X)")).toBe(
      "<b>user2 (Mister X)</b> marked this pull request ready for review.",
    );
  });
});

describe("issueActionMergeLine (mail.issue.action.merge — the MergePullRequest arm)", () => {
  it("'<b>%[1]s</b> merged #%[2]d into %[3]s.' — the base branch escapes like the display name (TrHTML plain-string args)", () => {
    expect(issueActionMergeLine("user2 (Mister X)", 7, "main")).toBe(
      "<b>user2 (Mister X)</b> merged #7 into main.",
    );
    expect(issueActionMergeLine("user2", 7, 'rel<"1">&x')).toBe(
      "<b>user2</b> merged #7 into rel&lt;&quot;1&quot;&gt;&amp;x.",
    );
  });
});

// ---------------------------------------------------------------------------
// The assigned mail — templates/mail/repo/issue/assigned.tmpl (the ONE named
// issue template at the pin; the IssueChangeAssignee arm's render,
// mail_issue.go:200-232 → composeIssueCommentMessages' CommentTypeAssignees
// branch, mail_issue_common.go:261)
// ---------------------------------------------------------------------------

describe("renderIssueAssignedMail (assigned.tmpl layout)", () => {
  const render = (over: Partial<Parameters<typeof renderIssueAssignedMail>[0]> = {}) =>
    renderIssueAssignedMail({
      subject: "Re: [user2/repo1] issue1 (#1)",
      isPull: false,
      doerDisplayName: "user2",
      link: "https://x.example/user2/repo1/issues/1#issuecomment-9",
      issueIndex: 1,
      repoHtmlUrl: "https://x.example/user2/repo1",
      repoPath: "user2/repo1",
      appName: "Gitea",
      appUrl: "https://x.example/",
      ...over,
    });

  it("pins the assigned.tmpl byte trace: the head gap, the single locale <p>, the dropped CanReply line, the footer", () => {
    const html = render();
    // </head> + the blank line + the two dropped {{$var}} declarations leave
    // three bare newlines; the locale line rides 3-tab indented with the
    // template's own SINGLE-quoted HTMLFormat anchors; the dropped
    // {{if .CanReply}} leaves its own "\t\n" before the footer's "\t".
    expect(html).toContain(
      "</head>\n\n\n\n<body>\n\t<p>\n\t\t\n\t\t\tuser2 assigned you to issue <a href='https://x.example/user2/repo1/issues/1#issuecomment-9'>#1</a> in repository <a href='https://x.example/user2/repo1'>user2/repo1</a>.\n\t\t\n\t</p>\n\t\n\t<table",
    );
    expect(html.startsWith("<!DOCTYPE html>\n<html>\n<head>\n\t<meta")).toBe(true);
    expect(html).toContain("<title>Re: [user2/repo1] issue1 (#1)</title>");
    expect(html).toContain('<a href="https://x.example/">Gitea</a>');
    expect(html.endsWith("</table>\n\n</body>\n</html>")).toBe(true);
  });

  it("IsPull picks mail.issue_assigned.pull — 'assigned you to pull request'", () => {
    expect(
      render({ isPull: true }).includes("user2 assigned you to pull request <a href="),
    ).toBe(true);
    expect(render().includes("assigned you to issue <a href=")).toBe(true);
  });

  it("escapes the display name, the link and the repo path (html/template element context); the locale line carries NO <b> wrapper", () => {
    const hostile = render({
      doerDisplayName: "<b>Eve</b> & Sons",
      link: "https://x.example/o/r/issues/1?a=1&b=2#issuecomment-9",
      repoPath: "o/r & co",
    });
    expect(hostile).toContain("&lt;b&gt;Eve&lt;/b&gt; &amp; Sons assigned you to issue");
    expect(hostile).toContain("<a href='https://x.example/o/r/issues/1?a=1&amp;b=2#issuecomment-9'>");
    expect(hostile).toContain(">o/r &amp; co</a>");
    expect(hostile).not.toContain("<b>user2</b> assigned");
  });
});

// ---------------------------------------------------------------------------
// The review family's render pieces (SPEC §14.6): the verdict action lines
// (actionToTemplate's CommentTypeReview branch) + the IsMention batch line
// (default.tmpl's x_mentioned_you if above the <p> block).
// ---------------------------------------------------------------------------

describe("the review verdict lines (mail.issue.action.approve|reject|review)", () => {
  it("pins the three locale lines verbatim, the display name escaped", () => {
    expect(issueActionApproveLine("user2")).toBe("<b>user2</b> approved this pull request.");
    expect(issueActionRejectLine("user2")).toBe("<b>user2</b> requested changes on this pull request.");
    expect(issueActionReviewLine("user2")).toBe("<b>user2</b> commented on this pull request.");
    expect(issueActionApproveLine('<b>Eve</b>')).toBe("<b>&lt;b&gt;Eve&lt;/b&gt;</b> approved this pull request.");
  });

  it("the approve arm renders the line ALWAYS (empty or kept body) — default.tmpl's first action chain", () => {
    const base = {
      subject: "Re: [user2/repo1] issue1 (#1)",
      link: "https://x.example/user2/repo1/pulls/1",
      issueIndex: 1,
      appName: "Gitea",
      appUrl: "https://x.example/",
    };
    // Kept body: the line + body shape (the ready_for_review twin's).
    const withBody = renderIssueActionMail({ ...base, actionName: "approve", bodyHtml: "<p>lgtm</p>\n", actionLineHtml: issueActionApproveLine("user2") });
    expect(withBody).toContain("\t<p>\n\t\t\n\t\t\t<b>user2</b> approved this pull request.\n\t\t\n\t\t\t<p>lgtm</p>\n\n\t\t</p>");
    // Empty body: the line + the empty-body branch.
    const noBody = renderIssueActionMail({ ...base, actionName: "reject", bodyHtml: "", actionLineHtml: issueActionRejectLine("user2") });
    expect(noBody).toContain("\t<p>\n\t\t\n\t\t\t<b>user2</b> requested changes on this pull request.\n\t\t\n\t\t\t\n\t\t</p>");
  });
});

describe("the IsMention line (mail.issue.x_mentioned_you — default.tmpl's first body line)", () => {
  const base = {
    subject: "Re: [user2/repo1] issue1 (#1)",
    actionName: "comment" as const,
    bodyHtml: "<p>look here</p>\n",
    actionLineHtml: null,
    link: "https://x.example/user2/repo1/pulls/1#issuecomment-9",
    issueIndex: 1,
    appName: "Gitea",
    appUrl: "https://x.example/",
  };

  it("isMention renders the locale line on the first tab line — .Doer.Name RAW, escaped", () => {
    const html = renderIssueActionMail({ ...base, isMention: true, doerName: "doer" });
    expect(html).toContain("<body>\n\t<p><b>doer</b> mentioned you:</p>\n\t\n\t<p>");
    const hostile = renderIssueActionMail({ ...base, isMention: true, doerName: "<script>" });
    expect(hostile).toContain("<p><b>&lt;script&gt;</b> mentioned you:</p>");
  });

  it("absent (the pre-fold default) leaves the bare tab line — byte-identical to every landed arm", () => {
    const html = renderIssueActionMail(base);
    expect(html).toContain("<body>\n\t\n\t\n\t<p>");
    expect(html).not.toContain("mentioned you");
  });
});

// ---------------------------------------------------------------------------
// The M1/M3/M4 render pieces (the ledger's §1.4 pass — SPEC §15): the
// review_dismissed line, the push line + commit list (default.tmpl's push
// blocks), the ReviewComments excerpt blocks, and the CanReply link-line
// half.
// ---------------------------------------------------------------------------

describe("issueActionReviewDismissedLine (mail.issue.action.review_dismissed — the PullReviewDismiss arm)", () => {
  it("'<b>%[1]s</b> dismissed last review from %[2]s for this pull request.' — both plain-string args escaped (the locale <b>s only %[1]s)", () => {
    expect(issueActionReviewDismissedLine("admin1", "user2 (Mister X)")).toBe(
      "<b>admin1</b> dismissed last review from user2 (Mister X) for this pull request.",
    );
    expect(issueActionReviewDismissedLine("<i>e</i>", 'r<"1">&x')).toBe(
      "<b>&lt;i&gt;e&lt;/i&gt;</b> dismissed last review from r&lt;&quot;1&quot;&gt;&amp;x for this pull request.",
    );
  });
});

describe("shortSha (modules/base/tool.go:31-33)", () => {
  it("truncates to the first 10 runes", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456789");
    expect(shortSha("abc")).toBe("abc");
  });
});

describe("issueActionPushLine (default.tmpl:9-25 — the push arm's top <p> block)", () => {
  it("normal push: TrN picks push_1/push_n — no trailing period, the branch escapes", () => {
    expect(
      issueActionPushLine({ doerDisplayName: "user2", headBranch: "feature", repoHtmlUrl: "https://x.example/u/r", isForcePush: false, commitCount: 1 }),
    ).toBe("<b>user2</b> pushed 1 commit to feature");
    expect(
      issueActionPushLine({ doerDisplayName: "user2", headBranch: "feature", repoHtmlUrl: "https://x.example/u/r", isForcePush: false, commitCount: 3 }),
    ).toBe("<b>user2</b> pushed 3 commits to feature");
    expect(
      issueActionPushLine({ doerDisplayName: "user2", headBranch: 'f<"1">', repoHtmlUrl: "https://x.example/u/r", isForcePush: false, commitCount: 2 }),
    ).toBe("<b>user2</b> pushed 2 commits to f&lt;&quot;1&quot;&gt;");
  });

  it("force push: the force_push line with HTMLFormat anchors (raw through the locale, single-quoted hrefs, ShortSha labels)", () => {
    expect(
      issueActionPushLine({
        doerDisplayName: "user2",
        headBranch: "main",
        repoHtmlUrl: "https://x.example/u/r",
        isForcePush: true,
        commitCount: 0,
        oldCommit: "aaaaaaaaaatest",
        newCommit: "bbbbbbbbbbtest",
      }),
    ).toBe(
      "<b>user2</b> force-pushed the <b>main</b> from <a href='https://x.example/u/r/commit/aaaaaaaaaatest'><b>aaaaaaaaaa</b></a> to <a href='https://x.example/u/r/commit/bbbbbbbbbbtest'><b>bbbbbbbbbb</b></a>.",
    );
  });
});

describe("issuePushCommitListHtml (default.tmpl:61-71 — the push arm's <ul>)", () => {
  it("one li per commit: ShortSha anchor + ' - ' + the MessageTitle, escaped; the range-boundary tabs trace", () => {
    expect(
      issuePushCommitListHtml("https://x.example/u/r", [
        { sha: "1111111111deadbeef", title: "first <change>" },
        { sha: "2222222222feedface", title: "second" },
      ]),
    ).toBe(
      "\t<ul>\n\t\t\n\t\t\t\n\t\t\t<li>\n\t\t\t\t<a href=\"https://x.example/u/r/commit/1111111111deadbeef\">1111111111</a> - first &lt;change&gt;\n\t\t\t</li>" +
        "\n\t\t\t\n\t\t\t<li>\n\t\t\t\t<a href=\"https://x.example/u/r/commit/2222222222feedface\">2222222222</a> - second\n\t\t\t</li>\n\t\t\n\t\t</ul>",
    );
  });

  it("the force-push shell: an EMPTY list renders the bare ul (Commits stays nil for the boundary pair)", () => {
    expect(issuePushCommitListHtml("https://x.example/u/r", [])).toBe("\t<ul>\n\t\t\n\n\t\t\n\t\t</ul>");
  });
});

describe("renderIssueActionMail — the push arm blocks, the ReviewComments excerpts, the CanReply half", () => {
  const base = {
    subject: "Re: [user2/repo1] issue1 (#1)",
    actionName: "push" as const,
    bodyHtml: "",
    actionLineHtml: null,
    link: "https://x.example/user2/repo1/pulls/1#issuecomment-9",
    issueIndex: 1,
    appName: "Gitea",
    appUrl: "https://x.example/",
  };

  it("push: the top line + the commit list fill the two dropped-if lines; the main <p> is the empty-body shape", () => {
    const html = renderIssueActionMail({
      ...base,
      pushLineHtml: issueActionPushLine({ doerDisplayName: "user2", headBranch: "main", repoHtmlUrl: "https://x.example/u/r", isForcePush: false, commitCount: 2 }),
      pushCommitsHtml: issuePushCommitListHtml("https://x.example/u/r", [{ sha: "1111111111x", title: "t" }]),
    });
    expect(html).toContain("<body>\n\t\n\t<b>user2</b> pushed 2 commits to main\n\t<p>\n\t\t\n\t\t\t\n\t\t</p>");
    expect(html).toContain("\t<ul>\n\t\t\n\t\t\t\n\t\t\t<li>");
    expect(html).toContain("\t<p><a href=\"https://x.example/user2/repo1/pulls/1#issuecomment-9\">#1</a>.</p>");
  });

  it("non-push arms keep BOTH bare tab lines even if push data is supplied (the {{if}} keys on ActionName)", () => {
    const html = renderIssueActionMail({
      ...base,
      actionName: "close",
      actionLineHtml: issueActionCloseLine("user2", 1),
      pushLineHtml: "SHOULD NOT RENDER",
      pushCommitsHtml: "NEITHER",
    });
    expect(html).not.toContain("SHOULD NOT RENDER");
    expect(html).not.toContain("NEITHER");
  });

  it("ReviewComments: each iteration rides inside the main <p> after the body branch; </p> loses its leading tabs", () => {
    const html = renderIssueActionMail({
      ...base,
      actionName: "review",
      actionLineHtml: issueActionReviewLine("user2"),
      bodyHtml: "<p>lgtm</p>\n",
      reviewComments: [{ treePath: "src/main.go", patchHtml: "@@ -1 +1 @@\n-x\n+y", contentHtml: "<p>here</p>" }],
    });
    expect(html).toContain(
      "\t\t\t<p>lgtm</p>\n\n\t\t\n\t\t\t<hr>\n\t\t\tIn src/main.go:\n\t\t\t<div style=\"padding-left: 1em; margin: 1em 0;\">\n\t\t\t\t<pre style=\"padding: 1em; border-left: 1px solid grey;\">@@ -1 +1 @@\n-x\n+y</pre>\n\t\t\t\t<div><p>here</p></div>\n\t\t\t</div>\n\t\t</p>",
    );
  });

  it("canReply renders the mail.reply half — ' or reply to this email directly' inside the link line", () => {
    expect(renderIssueActionMail(base).includes(">#1</a>.</p>")).toBe(true);
    const withReply = renderIssueActionMail({ ...base, canReply: true });
    expect(withReply).toContain('>#1</a> or reply to this email directly.</p>');
  });
});
