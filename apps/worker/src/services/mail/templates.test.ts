/**
 * The register-notify template render (services/mail/templates.ts) — pinned
 * against the pin's own strings: `mail.register_notify.title/.text_1/.text_2/
 * .text_3` and `mail.hi_user_x` verbatim from
 * gitea/options/locale/locale_en-US.json, the layout of
 * templates/mail/user/auth/register_notify.tmpl over mail/base/{head,footer}.
 */

import { describe, expect, it } from "vitest";

import {
  dotEscape,
  escapeHtml,
  registerNotifySubject,
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
