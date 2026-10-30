/**
 * The security-headers layer (usability F2, docs/usability/findings-latency-health.md):
 * the response-header hardening class was absent on every response class — no
 * `X-Content-Type-Options`, no `Content-Security-Policy`, no `X-Frame-Options`.
 *
 * Upstream posture at the pin (fc493688), the decision source for every value
 * below:
 *
 * - `SecurityHeadersHandler` (routers/common/middleware.go:48-64) rides
 *   `ProtocolMiddlewares` (middleware.go:29), wired tree-wide at
 *   routers/init.go:178 — it stamps TWO headers on EVERY response leaving
 *   Gitea, web and api alike, both config-driven with "unset" opt-outs:
 *     - `X-Content-Type-Options: nosniff` (default,
 *       modules/setting/security.go:28);
 *     - `X-Frame-Options: SAMEORIGIN` (default, security.go:27).
 *   The per-arm repeats (e.g. `plainTextInternal`'s nosniff on error/plain
 *   renders, services/context/base.go:134) are redundant under the global
 *   handler — our ad-hoc arm headers (the plain-text families that hand-set
 *   nosniff upstream-faithfully) stay untouched and set-if-absent unifies
 *   rather than fights them.
 * - CSP on pages is upstream's exact general policy
 *   (`WebContentSecurityPolicy`, services/context/context_template.go:116-141,
 *   emitted per page via the head template's
 *   `HeadMetaContentSecurityPolicy` meta tag — templates/base/head.tmpl:4 —
 *   and as a RESPONSE HEADER by `SetHeaderContentSecurityPolicyGeneral`
 *   (services/context/base.go:205-210) at its two header call sites:
 *   routers/common/markup.go:34 and routers/web/repo/render.go:69):
 *
 *       default-src * data: blob:;script-src * 'nonce-<32-byte-hex>';style-src * 'unsafe-inline';
 *
 *   with `""` (the landed default) enabling it and `"unset"` disabling
 *   (context_template.go:118-119; modules/setting/security.go:23 carries no
 *   initializer, so the zero value "" IS the enabled default).
 * - HSTS: upstream sets NO `Strict-Transport-Security` anywhere at the pin
 *   (the string does not occur in the Go tree) — TLS posture belongs to the
 *   reverse proxy/edge, and Cloudflare's edge applies its own zone-level HSTS.
 *   Not duplicated here, per the upstream-parity rule.
 *
 * THE ONE DIVERGENCE — the CSP nonce arm. Upstream's policy gates inline
 * scripts behind a per-request nonce that its templates stamp onto their own
 * inline `<script nonce>` tags (`CspScriptNonce`, base.go:194-203;
 * `ScriptImport`, context_template.go:98-108). Our page modules deliberately
 * ship nonce-less inline artifacts (SPEC-0008 §4.14: "verbatim head_script.tmpl
 * minus the nonce") — the error collector, the frontendInited canary and the
 * demo-banner dismissal — and this unit's ownership excludes page modules, so
 * no nonce attribute can be stamped into the HTML to match a nonce'd header
 * (and a nonce'd header with unstamped tags would silently kill the official
 * bundle's boot: the collector, the canary, the dismissal). Hash-pin instead?
 * The same cross-ownership trap: any shell-side byte edit would need a
 * coordinated policy edit. The faithful adaptation therefore keeps upstream's
 * policy SHAPE and host posture, swapping the nonce for 'unsafe-inline' —
 * CSP honors 'unsafe-inline' only while NO nonce/hash source is present, so
 * the directive is emitted WITHOUT any nonce:
 *
 *     default-src * data: blob:;script-src * 'unsafe-inline';style-src * 'unsafe-inline';
 *
 * Capability-equivalent to upstream (scripts from any host + the inline
 * artifacts the shell actually ships run; everything upstream allows still
 * loads), and the goldens-conformance scan in web/security-headers.test.ts
 * pins that nothing the shell emits needs more than this.
 *
 * Placement mirrors upstream's "every response that leaves Gitea" semantic:
 * the Hono middleware here is mounted `app.use("*")` in src/index.ts (the
 * parent wraps every merged sub-app route — uiRouter/session/first-run/avatars/
 * attachments/api trees), and the dispatcher's NON-Hono exits (the gitHttpGate
 * passthrough and the direct-served 404 shell) plus the `app.onError` arm
 * (whose response bypasses post-`next()` middleware stamping — the same reason
 * onError hand-sets its own cache-control) call `withSecurityHeaders`
 * directly. Headers ride the EXISTING Response — the body stream is carried
 * by reference, never buffered (AGENTS.md Workers rules).
 */

import type { MiddlewareHandler } from "hono";

/**
 * The page CSP — upstream's `WebContentSecurityPolicy` shape
 * (context_template.go:130-141) with the documented nonce → 'unsafe-inline'
 * adaptation (module header). Applied ONLY to `text/html` responses; upstream
 * scopes its header arm to the markup/render surfaces and carries the page
 * arm in the head meta — every upstream HTML surface ends up behind the same
 * policy either way, and text/html is exactly that class.
 */
export const PAGE_CONTENT_SECURITY_POLICY =
  "default-src * data: blob:;script-src * 'unsafe-inline';style-src * 'unsafe-inline';";

/** Upstream's landed `XFrameOptions` default (modules/setting/security.go:27). */
export const X_FRAME_OPTIONS = "SAMEORIGIN";

/** Upstream's landed `XContentTypeOptions` default (security.go:28). */
export const X_CONTENT_TYPE_OPTIONS = "nosniff";

/**
 * Stamp the class matrix onto one response. Set-if-absent: a handler that
 * deliberately set one of these headers (the raw/media `sandbox` CSP matrix in
 * ui/pages/raw-files.ts + wiki-raw.ts — upstream's ServeSetHeaders,
 * modules/httplib/serve.go:60-76 — sets or DELETES CSP per content class)
 * keeps its value, exactly like a handler running after upstream's
 * SecurityHeadersHandler. Returns the SAME Response object when nothing is
 * missing (the common case after the middleware already stamped it) — no
 * re-wrap, no header duplication.
 */
export function withSecurityHeaders(res: Response): Response {
  const isHtml = (res.headers.get("content-type") ?? "")
    .trim()
    .toLowerCase()
    .startsWith("text/html");
  const missing: Array<[string, string]> = [];
  if (res.headers.get("x-content-type-options") === null) {
    missing.push(["x-content-type-options", X_CONTENT_TYPE_OPTIONS]);
  }
  if (res.headers.get("x-frame-options") === null) {
    missing.push(["x-frame-options", X_FRAME_OPTIONS]);
  }
  if (isHtml && res.headers.get("content-security-policy") === null) {
    missing.push(["content-security-policy", PAGE_CONTENT_SECURITY_POLICY]);
  }
  if (missing.length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [name, value] of missing) headers.set(name, value);
  // Body by reference — git packs, LFS chunks and asset streams stay
  // streaming; a 204/304's null body passes through as null.
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The Hono middleware — upstream's SecurityHeadersHandler (module header for
 * the placement rationale). Post-`next()` stamping, the uiRouter
 * cache-control middleware's exact shape (src/ui/index.ts, the RD20
 * middleware): reads the HANDLER's response, so the CSP class decision sees
 * the final Content-Type.
 */
export function securityHeaders(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res !== undefined) {
      c.res = withSecurityHeaders(res);
    }
  };
}
