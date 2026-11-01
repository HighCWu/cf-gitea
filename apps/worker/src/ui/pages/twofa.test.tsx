/**
 * The twofa pages' tests: the DOM contract of the gate pair (twofa.tmpl +
 * twofa_scratch.tmpl at the pin — the sign-in shell, the attached
 * header/segment pair, the field attributes, the scratch link) and the
 * enroll page (twofa_enroll.tmpl over the settings layout — the no-QR
 * divergence's URI block, the manual-secret line, the passcode form), plus
 * the §5.5 a11y smoke over all three renders.
 *
 * The failure re-renders (the 200-with-negative-message posture) are
 * asserted on the same components — the error slot is the template's
 * `base/alert` reduction.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { runA11y } from "../__tests__/a11y";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { TwofaEnrollPage, TwofaPage, TwofaScratchPage, renderTwofaGatePage, renderTwofaScratchPage, twofaLocale } from "./twofa";

// --- fixtures (the user-settings-security.test.tsx harness) -------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const anonymous: Viewer = { kind: "anonymous" };
const ctx: UiContext = {
  viewer: anonymous,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

describe("the gate passcode page (twofa.tmpl's byte-shape)", () => {
  const html = () => renderToString(<TwofaPage ctx={ctx} error={null} />);

  it("renders the sign-in shell with the attached header/segment pair", () => {
    const out = html();
    expect(out).toContain('class="page-content user signin"'); // layout_head's pageClass discriminator
    expect(out).toContain(`<h3 class="ui top attached header">${twofaLocale.twofa}</h3>`);
    expect(out).toContain('class="ui attached segment"');
  });

  it("the form posts the passcode to /user/two_factor with the one-time-code attributes", () => {
    const out = html();
    expect(out).toContain('<form class="ui form tw-max-w-2xl tw-m-auto" action="/user/two_factor" method="post">');
    expect(out).toContain('name="passcode"');
    expect(out).toContain('autocomplete="one-time-code"');
    expect(out).toContain('inputmode="numeric"');
    expect(out).toContain('pattern="[0-9]*"');
    expect(out).toContain("autofocus");
    expect(out).toContain("required");
  });

  it("links the scratch arm (twofa.tmpl's use_scratch_code anchor)", () => {
    const out = html();
    expect(out).toContain('<a href="/user/two_factor/scratch">');
    expect(out).toContain(twofaLocale.use_scratch_code);
  });

  it("the failure re-render carries the inline negative message (the 200 posture)", () => {
    const out = renderToString(<TwofaPage ctx={ctx} error={twofaLocale.passcode_incorrect} />);
    expect(out).toContain('<div class="ui negative message">');
    expect(out).toContain(twofaLocale.passcode_incorrect);
  });

  it("the full-document render embeds the page (the router's entry)", () => {
    expect(renderTwofaGatePage({ ctx, error: null })).toContain('action="/user/two_factor"');
  });

  it("passes the a11y smoke", () => {
    const violations = runA11y(renderTwofaGatePage({ ctx, error: null }));
    expect(violations).toEqual([]);
  });
});

describe("the gate scratch page (twofa_scratch.tmpl's byte-shape)", () => {
  it("renders the scratch field to /user/two_factor/scratch, autocomplete off", () => {
    const out = renderToString(<TwofaScratchPage ctx={ctx} error={null} />);
    expect(out).toContain('<form class="ui form tw-max-w-2xl tw-m-auto" action="/user/two_factor/scratch" method="post">');
    expect(out).toContain(`<h3 class="ui top attached header">${twofaLocale.twofa_scratch}</h3>`);
    expect(out).toContain('id="token" name="token"');
    expect(out).toContain('autocomplete="off"');
    expect(out).not.toContain('href="/user/two_factor/scratch"'); // no scratch link on the scratch page itself
  });

  it("the failure re-render carries the scratch-incorrect message", () => {
    const out = renderToString(<TwofaScratchPage ctx={ctx} error={twofaLocale.scratch_token_incorrect} />);
    expect(out).toContain(twofaLocale.scratch_token_incorrect);
  });

  it("the full-document render + a11y smoke", () => {
    const full = renderTwofaScratchPage({ ctx, error: null });
    expect(full).toContain('action="/user/two_factor/scratch"');
    expect(runA11y(full)).toEqual([]);
  });
});

describe("the enroll page (twofa_enroll.tmpl over the settings layout)", () => {
  const data = {
    secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    uri: "otpauth://totp/Gitea%20(test.local):alice?algorithm=SHA1&digits=6&issuer=Gitea%20(test.local)&period=30&secret=JBSWY3DPEHPK3PXP",
  };

  it("renders the settings twofa layout with the enroll header", () => {
    const out = renderToString(<TwofaEnrollPage ctx={{ ...ctx, viewer: { kind: "user", id: 1, username: "alice", isAdmin: false } }} data={data} />);
    expect(out).toContain('class="page-content user settings twofa"');
    expect(out).toContain(`<h4 class="ui top attached header">${twofaLocale.twofa_enroll}</h4>`);
  });

  it("the no-QR divergence renders the otpauth URI itself (no QR data-URI image)", () => {
    const out = renderToString(<TwofaEnrollPage ctx={ctx} data={data} />);
    // hono/jsx escapes & in attributes/text — assert the escaped body
    expect(out).toContain(data.uri.replace(/&/g, "&amp;"));
    // the QR arm's marker (upstream's data:image/png;base64,... QrUri) never renders
    expect(out).not.toContain("data:image/png");
    expect(out).toContain(twofaLocale.or_enter_secret.replace("%s", data.secret));
    expect(out).toContain(twofaLocale.then_enter_passcode);
  });

  it("the passcode form posts to the enroll route", () => {
    const out = renderToString(<TwofaEnrollPage ctx={ctx} data={data} />);
    expect(out).toContain('<form class="ui form" action="/user/settings/security/two_factor/enroll" method="post">');
    expect(out).toContain('id="passcode" name="passcode"');
  });

  it("passes the a11y smoke (the code block is text, the form labeled)", () => {
    const full = renderToString(<TwofaEnrollPage ctx={ctx} data={data} />);
    expect(runA11y(full)).toEqual([]);
  });
});
