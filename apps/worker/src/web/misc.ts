/**
 * The `routers/web/misc` web family at the pin (web.go:544-547 — the last
 * open census row): the header theme switcher's JSON pair, the site banner
 * dismissal POST, and the markdown preview render. All four are SITE-LEVEL
 * web routes (never /api/v1 ops, never repo-scoped) — the well-known.ts
 * precedent applies: a plain Hono sub-app, outside the zod-openapi tier,
 * the frozen OpenAPI contract gains nothing.
 *
 *   POST /-/markup                  web.go:544  reqSignIn + web.Bind[MarkupOption] + misc.Markup
 *   POST /-/web-banner/dismiss      web.go:545  misc.WebBannerDismiss (ungated)
 *   GET  /-/web-theme/list          web.go:546  misc.WebThemeList (ungated)
 *   POST /-/web-theme/apply         web.go:547  crossOriginProtect + misc.WebThemeApply
 *
 * Gate census (verify-each, the brief's table):
 *   - markup: reqSignIn (web.go:355 — verifyAuthWithOptionsWeb{SignInRequired}).
 *     Anonymous → ctx.RedirectForLogin (base.go:161-169): the X-Gitea-Fetch-
 *     Action header flips a 401 `{"redirect": …}` JSON arm, everything else
 *     303s onto the login form with the full RequestURI as `redirect_to`.
 *     Our web login lives at `/login` (the SPEC-0010 §2.1 adaptation of
 *     upstream `/user/login`), so the redirect target is the landed session
 *     family's — the exact string `loginRedirect` (ui/index.ts) emits.
 *   - banner dismiss + theme list: NO middleware upstream — public.
 *   - theme apply: `crossOriginProtect` ONLY (web.go:358 —
 *     VerifyOptions{DisableCrossOriginProtection: false}, the zero-option
 *     middleware whose sole job is Go's `http.NewCrossOriginProtection()`
 *     check, net/http/csrf.go:130-171). NOT reqSignIn: anonymous visitors
 *     persist the choice in the `gitea_theme` site cookie (webtheme.go:40).
 *
 * ## Theme list (webtheme.go:18-32 + services/webtheme)
 *
 * Upstream discovers themes by scanning the built assets for
 * `theme-*.css` and parsing each file's `gitea-theme-meta-info` CSS block
 * (services/webtheme/webtheme.go:28-97); ours reads the SAME theme CSS
 * files through the landed manifest seam (ui/manifest.ts — the keys are the
 * unhashed `web_src/css/themes/theme-*.css`, so no hash guessing). The
 * response is `{"results": [{name, value, class}]}` where `name` is
 * RenderThemeItem's HTML (util_render.go:248-258 — the color-scheme icon at
 * size 14, the display name, the colorblind extra icon, all wrapped in
 * `div.theme-menu-item[data-tooltip-content]`), `value` the internal name
 * (what apply takes), `class` `"item js-aria-clickable"` + `" selected"`
 * for the CURRENT theme (webtheme.go:28). The current theme resolves
 * Doer.Theme → cookie `gitea_theme` → default (context_template.go:57-66
 * CurrentWebTheme + GuaranteeGetThemeMetaInfo's fallback chain), so an
 * unknown stored name selects the default item. Sort: default theme first,
 * then colorblind type, then display name (webtheme.go:181-188); the
 * no-theme fallback is the single default-theme entry (webtheme.go:233-237).
 * The 9 vendored themes carry the meta block, so the list is fully
 * decorated; a meta-less theme degrades to displayName = internalName
 * (webtheme.go:119-134). The parsed collection caches for the isolate
 * lifetime (deploy-immutable asset data — the manifest.ts posture, NOT the
 * banned per-request module state); `resetWebThemeCollectionCache` re-opens
 * it for tests.
 *
 * JSON spelling: upstream marshals with encoding/json/v2 (modules/json
 * default handler) — HTML chars are NOT escaped (probed against go1.25.1
 * stdlib: `<div` stays raw), map key ORDER is randomized per marshal (Go
 * map iteration — the frontend reads the fields by name), and nil slices
 * format as null (FormatNilSliceAsNull). Ours emits object-literal order
 * (name, value, class — the source's own order) and can never hit the nil
 * arm (the fallback guarantees at least one entry).
 *
 * ## Theme apply (webtheme.go:34-42)
 *
 * `ctx.FormString("theme")` — Go's ParseForm merges query + body with the
 * QUERY value first; the official frontend posts `?theme=<name>` on the
 * bare URL (common-page.ts initFooterThemeSelector). Signed in →
 * user_service.UpdateOptions{Theme} (the landed `user_settings.theme`
 * store, services/user-settings.ts — saveUserSettings, the upstream
 * creation default "gitea-auto"); the update ERROR is swallowed upstream
 * (`_ =`) and stays swallowed here. Anonymous →
 * `middleware.SetSiteCookie(…, CookieTheme="gitea_theme", 0)` — a SESSION
 * cookie (maxAge 0 = no Max-Age attribute) with SetSiteCookie's flags
 * (cookie.go:57-78: HttpOnly hardcoded; Path=CookiePath default "/";
 * Secure/SameSite from session config — our landed posture pins Secure
 * always, SameSite=Lax, the session.ts §4.9 note). The value is
 * url.QueryEscape'd (cookie.go:60); GET-side GetSiteCookie QueryUnescapes
 * (cookie.go:47-55, error → ""). Upstream does NOT validate the name — an
 * unknown theme stores verbatim and renders as the default next page
 * (GuaranteeGetThemeMetaInfo). Response: chi writes a bare 200 with an
 * EMPTY body (the frontend reloads on `ok`-less success via
 * handleFetchActionSuccessJson's reload arm).
 *
 * ## Banner dismiss (misc.go:82-86)
 *
 * `SetSiteCookie(gitea_disbnr, <revision>, 48*3600)` + ctx.JSONOK → 200
 * `{"ok":true}` (context.go:243-245, `application/json;charset=utf-8`).
 * The revision is `Instance.WebBanner.ValueRevision` — the dynamic-config
 * DB row counter (setting/config/value.go:83-127); an UNCONFIGURED option
 * has no row → revision 0, and cf-gitea has no `instance.web_banner` config
 * surface, so the cookie value is the constant "0" (a future banner config
 * plugs its revision here). The official frontend's `.link-action` handler
 * (fetch-action.ts:440-441) POSTs data-url and reloads on the JSON
 * response. Upstream renders no banner at default config
 * (WebBannerType.ShouldDisplay, config_option_instance.go:21-34) — the
 * endpoint is the parity surface behind head_banner.tmpl's dismiss button.
 *
 * ## Markup (markup.go:16-20 + common/markup.go RenderMarkup)
 *
 * `web.Bind[*structs.MarkupOption]` (modules/web/router.go:26-46 →
 * binding/binding.go:191-210) dispatches on Content-Type:
 * `*form-urlencoded` / `*multipart/form-data` bind the SNAKE_CASE field
 * names (binding.go:311 ToSnakeCase — `text`, `mode`, `context`, `wiki`;
 * the official ComboMarkdownEditor posts FormData, ComboMarkdownEditor.ts
 * :250-255), `*json` binds the struct keys case-insensitively, and ANY
 * other type (or a decode failure) leaves the form ZERO — the legacy bind
 * error path only sets template data, it never short-circuits the handler
 * chain (router.go:29-46), so Markup still runs on the zero form and
 * renders the empty string. `mode = util.Iif(form.Wiki, "wiki", form.Mode)`
 * (markup.go:18, the deprecated Wiki field); RenderMarkup then answers
 * mode ""/"markdown" with the raw renderer (markup.go:36-46, no context
 * handling) and dispatches gfm/comment/wiki/file through the repo-context
 * branch (markup.go:64-90) — the landed renderer service
 * (api/services/markdown.ts renderMarkdownToHtml) is that exact port, with
 * the 422 `unsupported render mode: <mode>` default arm as a thrown
 * ApiError. This handler is the WEB twin of the landed API
 * /markdown route (api/routes/markdown.ts) — one renderer, two surfaces.
 *
 * Response bytes: markup.Render writes the fragment with NO Content-Type —
 * Go's net/http sniffs the head bytes at write time (the render.go:248-250
 * comment is the tell). We compute the SAME value with the DetectContentType
 * port below (sniff.go:21-48: the HTML-lead signature table, the XML and
 * UTF-BOM masked sigs, `application/octet-stream` fallback; the binary
 * signature tail is unreachable for markdown HTML output — the source is
 * bound TEXT and `html:false` escapes every raw `<`) and set it explicitly,
 * so the response is byte-identical whether this router is probed
 * standalone (tests) or mounted. Errors use Go's `http.Error` shape
 * (base.go:105-114 → net/http Error): `text/plain; charset=utf-8` +
 * nosniff + message + "\n" — the 422 unsupported-mode arm and the 500
 * `failed to render markup` arm. The CSP header (markup.go:34
 * SetHeaderContentSecurityPolicyGeneral) rides every arm that passes the
 * gate — including both error arms (line 34 runs before the mode
 * dispatch), with the landed nonce → 'unsafe-inline' adaptation
 * (web/security-headers.ts — the same policy constant the global
 * middleware stamps; set-if-absent makes the mounted result identical to
 * the standalone bytes).
 *
 * ## The 405 method arms — chi's default handler (the well-known.ts port)
 *
 * Every route here is single-method upstream (three POSTs, one GET); chi
 * registers no HEAD fallback and answers the wrong-method miss with the
 * DEFAULT methodNotAllowedHandler — an EMPTY body and `Allow` ADDED PER
 * registered method, one wire line each (unknown methods outside chi's
 * methodMap 405 with NO Allow). Hono would auto-HEAD the GET registration,
 * so every route rides `.all` + an in-handler method dispatch (the
 * well-known.ts pattern, verbatim rationale).
 *
 * ## The CSRF check (net/http/csrf.go:130-171, ported verbatim)
 *
 * Safe methods pass. Otherwise: `Sec-Fetch-Site: same-origin|none` passes;
 * any OTHER value (same-site/cross-site/garbage) denies with
 * `cross-origin request detected from Sec-Fetch-Site header`; an ABSENT
 * header falls to the Origin check — absent Origin passes (non-browser
 * clients), an Origin whose `URL.host` equals the request `Host` header
 * passes (the fail-open old-browser arm), anything else denies with the
 * old-browser message. No trusted origins / bypass patterns exist (the
 * zero-value protection, csrf.go:29-30). Deny = Go http.Error 403 with the
 * exact error text. NOTE this is deliberately NOT the landed
 * sameOriginGuard (session.ts:654): different table (Sec-Fetch-Site
 * primary, Host-equality fail-open), different messages — upstream runs
 * BOTH layers independently (session cookie SameSite + this middleware).
 *
 * ## MOUNT HANDOFF (orchestrator-owned — this module does not touch
 * src/index.ts or ui/index.ts)
 *
 * The dispatcher's repo-scoped branch (`segments.length >= 2`,
 * src/index.ts:443) would swallow these paths: owner `-`, repo `markup` →
 * no D1 row → engine 404, BEFORE Hono sees the mount. The fix is the
 * isWellKnown carve's twin (src/index.ts:400/452), ONE line in the
 * orchestrator's carve list:
 *
 *     const isDashPath = segments[0] === "-";
 *     // in the isRepoScoped negation list:  !isDashPath &&
 *
 * then mount the sub-app beside the other plain-Hono seams (the
 * webWellKnownRouter block, src/index.ts:312-316):
 *
 *     import { webMiscRouter } from "./web/misc";
 *     app.route("/", webMiscRouter);
 *
 * Static exact paths only — NO `/-/*` wildcard here (a wildcard mounted
 * before uiRouter would shadow the landed `/-/admin` page family; unknown
 * tails keep the global not-found surface, upstream's own
 * unregistered-route posture). parseUiRoute needs NO claims: the admin
 * family's comment (ui/index.ts:4208-4211) already establishes `-` as a
 * namespace no repo can be named, and the carve hands the WHOLE `/-`
 * prefix to Hono where the exact registrations live. The four handlers are
 * exported as pure functions too, so a uiRouter-fold integration
 * (claims in parseUiRoute + uiRouter registrations delegating here) stays
 * available as the alternative shape. No API-contract operation: the
 * frozen OpenAPI surface gains nothing (`pnpm check:api` stays PASS).
 */

import { Hono } from "hono";

import { ApiError } from "../api/errors";
import { renderMarkdownToHtml } from "../api/services/markdown";
import { loadUserSettings, saveUserSettings } from "../api/services/user-settings";
import { loadManifest } from "../ui/manifest";
import { isFetchActionRequest } from "../ui/pages/repo-home";
import { resolveViewer, type ViewerResolution } from "../ui/viewer";
import { PAGE_CONTENT_SECURITY_POLICY, X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS } from "./security-headers";

/**
 * The env slice the routes read: D1 (viewer verification + the theme
 * preference store) and the ASSETS binding (the theme CSS store) — full
 * `Env`, the sessionRouter/linkAccountRouter posture (resolveViewer and
 * the mount site both carry the complete binding set). Tests override the
 * ASSETS property with a structural fetcher (the session.test.ts
 * UiTestEnv posture).
 */
export type MiscWebEnv = Env;

// ---------------------------------------------------------------------------
// Go byte-shape helpers (the well-known.ts / session.ts shapes)
// ---------------------------------------------------------------------------

/** chi v5.4.0's methodMap (mux.go): the methods whose 405 carries the
 *  `Allow` header. An unknown method misses the map and 405s bare. */
const CHI_KNOWN_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
  "QUERY",
]);

/** chi's default methodNotAllowedHandler (mux.go): empty body, `Allow`
 *  ADDED PER registered method (one wire line each). Unknown methods 405
 *  with NO Allow (the mux.go early arm). */
function chiMethodNotAllowed(method: string, allow: string[]): Response {
  const response = new Response(null, { status: 405 });
  if (CHI_KNOWN_METHODS.has(method)) {
    for (const value of allow) response.headers.append("allow", value);
  }
  return response;
}

/** Go `http.Error` (net/http/server.go → base.go:105-114 HTTPError): the
 *  message + "\n" through Fprintln, `text/plain; charset=utf-8` (WITH the
 *  space) and nosniff. */
function goHttpError(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** ctx.JSON's marshal (base.go:116-122): compact, no trailing newline,
 *  `application/json;charset=utf-8`. encoding/json/v2 (the modules/json
 *  default handler) leaves HTML chars raw — JSON.stringify matches (it
 *  escapes neither `<`, `>`, nor `&`). */
function goJson(status: number, content: object): Response {
  return new Response(JSON.stringify(content), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Go url.QueryEscape / QueryUnescape (net/url — the SetSiteCookie value
// encoding, cookie.go:60/47-55)
// ---------------------------------------------------------------------------

const QUERY_ESCAPE_UNRESERVED = /[A-Za-z0-9\-_.~]/;

function queryEscape(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    if (QUERY_ESCAPE_UNRESERVED.test(String.fromCharCode(byte))) out += String.fromCharCode(byte);
    else if (byte === 0x20) out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** `null` on a malformed escape (Go returns an error; GetSiteCookie
 *  discards it and serves ""). */
function queryUnescape(value: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "+") bytes.push(0x20);
    else if (ch === "%") {
      const hex = value.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else for (const byte of new TextEncoder().encode(ch)) bytes.push(byte);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** Read one request cookie the way Go's `req.Cookie(name)` +
 *  GetSiteCookie do (cookie.go:47-55): first matching pair, then
 *  QueryUnescape (error → ""). */
function getSiteCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie");
  if (header === null) return "";
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    if (pair.slice(0, at).trim() !== name) continue;
    const unescaped = queryUnescape(pair.slice(at + 1).trim());
    return unescaped ?? "";
  }
  return "";
}

/**
 * SetSiteCookie (cookie.go:57-78) with the landed flag posture (§4.9 —
 * session.ts sessionSetCookie's note): HttpOnly hardcoded, Path = the
 * CookiePath default "/", Secure always (our origins are https),
 * SameSite=Lax (session.go:39 default). Serialization is Go's
 * http.Cookie.String order: value, Path, Max-Age, HttpOnly, Secure,
 * SameSite. `maxAge > 0` emits `Max-Age=N`; `0` emits NO Max-Age
 * attribute (a session cookie) — the Go MaxAge<0 delete form never occurs
 * in this family.
 */
function setSiteCookie(name: string, value: string, maxAge: number): string {
  const parts = [`${name}=${queryEscape(value)}`, "Path=/"];
  if (maxAge > 0) parts.push(`Max-Age=${String(maxAge)}`);
  parts.push("HttpOnly", "Secure", "SameSite=Lax");
  return parts.join("; ");
}

/** Attach the viewer resolution's Set-Cookie directive (rotation /
 *  dead-cookie clear — the resolveViewer contract; upstream's session
 *  middleware re-stamps the cookie on every web response). */
function withSessionCookie(response: Response, setCookie: string | null): Response {
  if (setCookie === null) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", setCookie);
  return new Response(response.body, { status: response.status, headers });
}

// ---------------------------------------------------------------------------
// Go net/http DetectContentType (sniff.go:21-107) — the markup render's
// Content-Type (upstream leaves the header unset and lets net/http sniff)
// ---------------------------------------------------------------------------

const SNIFF_LEN = 512;

/** sniff.go's htmlSig table (sniff.go:66-83), in order. */
const HTML_SNIFF_SIGS = [
  "<!DOCTYPE HTML",
  "<HTML",
  "<HEAD",
  "<SCRIPT",
  "<IFRAME",
  "<H1",
  "<DIV",
  "<FONT",
  "<TABLE",
  "<A",
  "<STYLE",
  "<TITLE",
  "<B",
  "<BODY",
  "<BR",
  "<P",
  "<!--",
];

function isWs(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isTt(byte: number): boolean {
  return byte === 0x20 || byte === 0x3e;
}

/** htmlSig.match (sniff.go:173-189): case-folded prefix at firstNonWS,
 *  then a REQUIRED tag-terminating byte (space or `>`). */
function htmlSigMatch(data: Uint8Array, firstNonWs: number, sig: string): boolean {
  const sigBytes = new TextEncoder().encode(sig);
  const end = firstNonWs + sigBytes.length;
  if (end >= data.length) return false; // needs len(data) >= len(sig)+1 AND the terminator
  for (let i = 0; i < sigBytes.length; i++) {
    const want = sigBytes[i];
    const got = data[firstNonWs + i];
    if (want === undefined || got === undefined) return false;
    if ((want & 0xdf) !== (got & 0xdf)) return false;
  }
  return isTt(data[end] ?? 0);
}

/** The tail sigs reachable past the HTML table: `<?xml` (skipWS, mask
 *  FF×5 — ASCII `<?xml` byte-for-byte) and the UTF BOMs (no skipWS,
 *  anchored at 0, 4-byte masked patterns). The binary signature tail
 *  (images, audio, PDF…) is unreachable for markdown HTML output — the
 *  source is bound TEXT and `html:false` escapes every raw `<` — and is
 *  omitted (documented in the module header). */
function goDetectContentType(body: string): string {
  const data = new TextEncoder().encode(body);
  const view = data.length > SNIFF_LEN ? data.subarray(0, SNIFF_LEN) : data;
  let firstNonWs = 0;
  while (firstNonWs < view.length && isWs(view[firstNonWs] ?? 0)) firstNonWs++;
  for (const sig of HTML_SNIFF_SIGS) {
    if (htmlSigMatch(view, firstNonWs, sig)) return "text/html; charset=utf-8";
  }
  const xmlLead = "<?xml";
  if (view.length - firstNonWs >= xmlLead.length) {
    let isXml = true;
    for (let i = 0; i < xmlLead.length; i++) {
      if (view[firstNonWs + i] !== xmlLead.charCodeAt(i)) {
        isXml = false;
        break;
      }
    }
    if (isXml) return "text/xml; charset=utf-8";
  }
  const at = (index: number): number | undefined => view[index];
  const needsFourBytes = view.length >= 4;
  if (needsFourBytes && at(0) === 0xfe && at(1) === 0xff) return "text/plain; charset=utf-16be";
  if (needsFourBytes && at(0) === 0xff && at(1) === 0xfe) return "text/plain; charset=utf-16le";
  if (needsFourBytes && at(0) === 0xef && at(1) === 0xbb && at(2) === 0xbf) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// The theme collection (services/webtheme port over the manifest seam)
// ---------------------------------------------------------------------------

/** ThemeMetaInfo (webtheme.go:26-32), the fields the handler reads. */
export interface ThemeMetaInfo {
  /** The manifest key verbatim (`web_src/css/themes/theme-<name>.css`). */
  readonly fileName: string;
  readonly internalName: string;
  readonly displayName: string;
  readonly colorblindType: string;
  readonly colorScheme: string;
}

/** setting.UI.DefaultTheme (modules/setting/ui.go:99) — also the
 *  user_settings.theme column default (schema.ts:1570) and
 *  DEFAULT_USER_SETTINGS.theme (services/user-settings.ts). */
export const DEFAULT_WEB_THEME = "gitea-auto";

/** middleware.CookieTheme (modules/web/middleware/cookie.go:20). */
export const COOKIE_THEME = "gitea_theme";

/** middleware.CookieWebBannerDismissed (cookie.go:19). */
export const COOKIE_WEB_BANNER_DISMISSED = "gitea_disbnr";

/** The banner dismissal window — misc.go:84's `48*3600` seconds. */
export const WEB_BANNER_DISMISS_MAX_AGE_SECONDS = 48 * 3600;

/**
 * The banner's config revision (misc.go:83): the dynamic-config row
 * counter for `instance.web_banner`. cf-gitea has no banner config
 * surface, and an unconfigured option carries revision 0
 * (setting/config/value.go:83-127 — `has=false`), so the cookie value is
 * the constant "0". A future banner config plugs its ValueRevision here.
 */
const WEB_BANNER_REVISION = 0;

const THEME_KEY_PREFIX = "web_src/css/themes/theme-";
const THEME_KEY_SUFFIX = ".css";

/**
 * parseThemeMetaInfoToMap (webtheme.go:38-80): the `gitea-theme-meta-info`
 * CSS block's custom properties — the LAST occurrence wins (upstream
 * LastIndex), values may be quoted (either quote, with backslash
 * escapes) or bare. Returns null when no meta block exists.
 */
export function parseThemeCssMeta(cssContent: string): Record<string, string> | null {
  const blockStart = cssContent.lastIndexOf("gitea-theme-meta-info");
  if (blockStart < 0) return null;
  const tail = cssContent.slice(blockStart);
  const item = String.raw`\s*(--[-\w]+)\s*:\s*("(?:\\"|[^"])*"|'(?:\\'|[^'])*'|[^'";]+)\s*;?\s*`;
  // upstream wraps the item in its own parens before the `+`
  // (webtheme.go:66's reMetaInfoBlock) — without them the `+` would glue
  // onto the item's trailing `\s*` (an invalid quantifier stack).
  const block = new RegExp(String.raw`\bgitea-theme-meta-info\s*\{((?:` + item + String.raw`)+)\}`);
  const matchedBlock = block.exec(tail);
  if (matchedBlock === null || matchedBlock[1] === undefined) return null;
  const items = new RegExp(item, "g");
  const meta: Record<string, string> = {};
  for (const match of matchedBlock[1].matchAll(items)) {
    const key = match[1];
    let value = match[2] ?? "";
    if (value.startsWith('"')) {
      value = value.endsWith('"') ? value.slice(1, -1) : value.slice(1);
      value = value.replaceAll('\\"', '"');
    } else if (value.startsWith("'")) {
      value = value.endsWith("'") ? value.slice(1, -1) : value.slice(1);
      value = value.replaceAll("\\'", "'");
    }
    if (key !== undefined) meta[key] = value;
  }
  return meta;
}

/** defaultThemeMetaInfoByFileName + parseThemeMetaInfo (webtheme.go:101-134):
 *  the internal name comes from the UNHASHED manifest key (no hash
 *  guessing — our keys are the source entry names), the display name
 *  falls back to it, and a PRESENT meta block overwrites the three
 *  decorated fields (a block missing a key yields "" — the Go map zero). */
function parseThemeMetaInfo(fileName: string, cssContent: string): ThemeMetaInfo {
  const internalName = fileName.slice(THEME_KEY_PREFIX.length, fileName.length - THEME_KEY_SUFFIX.length);
  const info: ThemeMetaInfo = {
    fileName,
    internalName,
    displayName: internalName,
    colorblindType: "",
    colorScheme: "",
  };
  const meta = parseThemeCssMeta(cssContent);
  if (meta === null) return info;
  return {
    fileName,
    internalName,
    displayName: meta["--theme-display-name"] ?? "",
    colorblindType: meta["--theme-colorblind-type"] ?? "",
    colorScheme: meta["--theme-color-scheme"] ?? "",
  };
}

/** The sort comparator (webtheme.go:181-188): the default theme first,
 *  then colorblind type, then display name — Go string `<` (byte order).
 *  The comparator is upstream's own (non-transitive on the default-theme
 *  arm — one element matches the default, so the effective order is
 *  deterministic: default first, then (colorblind, name)). */
function compareThemes(a: ThemeMetaInfo, b: ThemeMetaInfo): number {
  if (a.internalName === DEFAULT_WEB_THEME) return -1;
  if (b.internalName === DEFAULT_WEB_THEME) return 1;
  if (a.colorblindType !== b.colorblindType) return a.colorblindType < b.colorblindType ? -1 : 1;
  if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1;
  return 0;
}

function defaultThemeMetaInfo(): ThemeMetaInfo {
  // defaultThemeMetaInfoByInternalName (webtheme.go:103-110).
  return {
    fileName: `${THEME_KEY_PREFIX}${DEFAULT_WEB_THEME}${THEME_KEY_SUFFIX}`,
    internalName: DEFAULT_WEB_THEME,
    displayName: DEFAULT_WEB_THEME,
    colorblindType: "",
    colorScheme: "",
  };
}

/** The asset base for the binding fetches — loadManifest's URL rule; the
 *  request origin stands in for the (unset) APP_URL (the WellKnownEnv
 *  fallback posture; the ASSETS binding is origin-agnostic). */
function assetsBaseUrl(requestUrl: string): string {
  return new URL(requestUrl).origin + "/";
}

/** loadThemesFromAssets (webtheme.go:166-179) over the manifest keys:
 *  every `theme-*.css` entry, parsed, per-file failures skipped (upstream
 *  logs and continues, webtheme.go:161-164), and the empty-list fallback
 *  to the single default entry (webtheme.go:233-237). A manifest LOAD
 *  failure takes the same fallback (upstream logs and returns the empty
 *  list). NOT cached — the collection cache below owns that. */
async function loadWebThemes(env: MiscWebEnv, baseUrl: string): Promise<ThemeMetaInfo[]> {
  const themes: ThemeMetaInfo[] = [];
  try {
    const manifest = await loadManifest(env.ASSETS, baseUrl);
    const keys = Object.keys(manifest).filter(
      (key) => key.startsWith(THEME_KEY_PREFIX) && key.endsWith(THEME_KEY_SUFFIX),
    );
    for (const key of keys) {
      const entry = manifest[key];
      if (entry === undefined) continue;
      try {
        const url = new URL(`assets/${entry.file}`, baseUrl);
        const response = await env.ASSETS.fetch(new Request(url.toString()));
        if (!response.ok) continue;
        themes.push(parseThemeMetaInfo(key, await response.text()));
      } catch {
        continue;
      }
    }
  } catch {
    // manifest load failure → the empty list → the default fallback below
  }
  if (themes.length === 0) return [defaultThemeMetaInfo()];
  return [...themes].sort(compareThemes);
}

/**
 * The parsed theme collection, cached for the isolate lifetime
 * (deploy-immutable asset data — the manifest.ts posture: NOT the banned
 * per-request module state). Only RESOLVED collections cache, so a broken
 * asset store re-falls-back per request instead of poisoning the isolate
 * (loadManifest caches its own failures; a poisoned manifest keeps this
 * cache from filling with the real list until reset — the same
 * reset-at-use contract as resetManifestCache).
 */
let cachedThemes: ThemeMetaInfo[] | null = null;

async function webThemeCollection(env: MiscWebEnv, baseUrl: string): Promise<ThemeMetaInfo[]> {
  if (cachedThemes !== null) return cachedThemes;
  cachedThemes = await loadWebThemes(env, baseUrl);
  return cachedThemes;
}

/** Drop the collection cache (tests / explicit re-pin reload). */
export function resetWebThemeCollectionCache(): void {
  cachedThemes = null;
}

// ---------------------------------------------------------------------------
// RenderThemeItem (util_render.go:248-258) + the svg.RenderHTML bytes
// ---------------------------------------------------------------------------

/**
 * The icon SVG markup — the pinned submodule's committed inputs
 * (gitea/public/assets/img/svg/<name>.svg) embedded VERBATIM (full
 * elements, multi-path/multi-element bodies included — the colorblind
 * icons are fill+clipPath compositions, not single paths), exactly what
 * upstream's svgIcons store holds after processing the same files. The
 * landed icons.generated.ts pipeline doesn't carry them (it exists for
 * the shell's octicon set), so the markup lives here; a regeneration of
 * the submodule pin updates these constants with the next theme family
 * that reads them. RenderHTML's size rewrite (svg.go:107-112) replaces
 * width/height IN PLACE — one occurrence each — so attribute order
 * survives at any size.
 */
const THEME_ICON_SVGS = {
  "octicon-paintbrush":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="svg octicon-paintbrush" width="16" height="16" aria-hidden="true"><path d="M11.134 1.535c.7-.509 1.416-.942 2.076-1.155.649-.21 1.463-.267 2.069.34.603.601.568 1.411.368 2.07-.202.668-.624 1.39-1.125 2.096-1.011 1.424-2.496 2.987-3.775 4.249-1.098 1.084-2.132 1.839-3.04 2.3a3.74 3.74 0 0 1-1.055 3.217c-.431.431-1.065.691-1.657.861-.614.177-1.294.287-1.914.357A21 21 0 0 1 .797 16H.743l.007-.75H.749L.742 16a.75.75 0 0 1-.743-.742l.743-.008-.742.007v-.054a21 21 0 0 1 .13-2.284q.101-.972.358-1.914c.17-.591.43-1.226.86-1.657a3.75 3.75 0 0 1 3.227-1.054c.466-.893 1.225-1.907 2.314-2.982 1.271-1.255 2.833-2.75 4.245-3.777M1.62 13.089q-.077.696-.104 1.395.7-.027 1.396-.104a10.5 10.5 0 0 0 1.668-.309c.526-.151.856-.325 1.011-.48a2.25 2.25 0 1 0-3.182-3.182c-.155.155-.329.485-.48 1.01a10.5 10.5 0 0 0-.309 1.67m10.396-10.34c-1.224.89-2.605 2.189-3.822 3.384l1.718 1.718c1.21-1.205 2.51-2.597 3.387-3.833.47-.662.78-1.227.912-1.662.134-.444.032-.551.009-.575h-.001V1.78c-.014-.014-.113-.113-.548.027-.432.14-.995.462-1.655.942m-4.832 7.266za10 10 0 0 0 1.63-1.142L7.155 7.216a9.7 9.7 0 0 0-1.161 1.607c.482.302.889.71 1.19 1.192"/></svg>',
  "octicon-moon":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="svg octicon-moon" width="16" height="16" aria-hidden="true"><path d="M9.598 1.591a.75.75 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786m1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678"/></svg>',
  "octicon-sun":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="svg octicon-sun" width="16" height="16" aria-hidden="true"><path d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8m0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5m5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.75.75 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0M8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0M3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8m13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8m-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13m3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061M2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 0 1-.018 1.042.75.75 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"/></svg>',
  "gitea-eclipse":
    '<svg viewBox="490 490 820 820" class="svg gitea-eclipse" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path d="M866.7 582.1A321.3 321.3 0 0 0 738.6 623a317.3 317.3 0 0 0-109.1 108.5A418 418 0 0 0 609 772a335.3 335.3 0 0 0-19.6 71.5 205.2 205.2 0 0 0-2.8 45c0 25.8.2 29.3 2.8 45 4.1 25.4 9.9 46.4 19.6 71.5a314.2 314.2 0 0 0 111.6 137.3A306.8 306.8 0 0 0 893 1196a308.6 308.6 0 0 0 303.6-262.5c2.6-15.7 2.8-19.2 2.8-45s-.2-29.3-2.8-45A335.3 335.3 0 0 0 1177 772a314.2 314.2 0 0 0-111.6-137.3A308.3 308.3 0 0 0 918 582c-13-1.1-38.2-1.1-51.3.1M747 663.5l-2.4 16.7c-4 26.4-4.9 41.1-4.3 65.3a323.7 323.7 0 0 0 37.2 145c18.2 36 41.3 66.6 72 95.5a346.4 346.4 0 0 0 208.5 93.1l18 1.6 4.5.5-8.5 8a259.3 259.3 0 0 1-141.5 65.8 281 281 0 0 1-123.9-11.4 267.2 267.2 0 0 1-181.7-269.9c2-27.6 5.7-47.6 13.3-70.7a281.2 281.2 0 0 1 46.4-85c8-10.1 28-30.2 37.9-38.1 13.8-11.1 24.5-18.3 24.5-16.4"/></svg>',
  "gitea-colorblind-redgreen":
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 40 40" class="svg gitea-colorblind-redgreen" width="16" height="16" aria-hidden="true"><g clip-path="url(#gitea-colorblind-redgreen__a)"><rect width="40" height="40" fill="#0000" rx="20"/><path fill="#0566d5" d="M34.284 34.284c7.81-7.81 7.81-20.474 0-28.284L6 34.284c7.81 7.81 20.474 7.81 28.284 0"/><path fill="#e7a100" d="M34.283 34.284c7.81-7.81 7.81-20.474 0-28.284L20.14 20.142z"/><circle cx="20" cy="20" r="18" fill="#0000" stroke="#aaa" stroke-width="4"/></g><defs><clipPath id="gitea-colorblind-redgreen__a"><rect width="40" height="40" fill="#0000" rx="20"/></clipPath></defs></svg>',
  "gitea-colorblind-blueyellow":
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 40 40" class="svg gitea-colorblind-blueyellow" width="16" height="16" aria-hidden="true"><g clip-path="url(#gitea-colorblind-blueyellow__a)"><rect width="40" height="40" fill="#0000" rx="20"/><path fill="#1d69e0" d="M34.284 34.284c7.81-7.81 7.81-20.474 0-28.284L6 34.284c7.81 7.81 20.474 7.81 28.284 0"/><path fill="#fa4549" d="M34.283 34.284c7.81-7.81 7.81-20.474 0-28.284L20.14 20.142z"/><circle cx="20" cy="20" r="18" fill="#0000" stroke="#aaa" stroke-width="4"/></g><defs><clipPath id="gitea-colorblind-blueyellow__a"><rect width="40" height="40" fill="#0000" rx="20"/></clipPath></defs></svg>',
} as const;

type ThemeIconName = keyof typeof THEME_ICON_SVGS;

/** svg.RenderHTML(name, size) (modules/svg/svg.go:82-125): the normalized
 *  committed SVG with width/height swapped for the requested size (the
 *  "hacky but works" string replacement, one occurrence each). An empty
 *  name renders "" (svg.go:88-90) — the colorblind-less themes' extra
 *  icon. */
function themeSvg(name: ThemeIconName | "", size: number): string {
  if (name === "") return "";
  return THEME_ICON_SVGS[name]
    .replace('width="16"', `width="${String(size)}"`)
    .replace('height="16"', `height="${String(size)}"`);
}

/** RenderThemeItem (util_render.go:248-258) — HTMLFormat's literal with
 *  its four verbs: the tooltip description, the scheme icon, the display
 *  name, the extra icon. An empty extra icon leaves the literal's
 *  trailing space before `</div>` (the `%s` verbs render regardless). */
function renderThemeItem(info: ThemeMetaInfo, iconSize: number): string {
  const svgName: ThemeIconName =
    info.colorScheme === "dark"
      ? "octicon-moon"
      : info.colorScheme === "light"
        ? "octicon-sun"
        : info.colorScheme === "auto"
          ? "gitea-eclipse"
          : "octicon-paintbrush";
  const description =
    info.colorblindType === "red-green"
      ? "Red-green colorblind friendly"
      : info.colorblindType === "blue-yellow"
        ? "Blue-yellow colorblind friendly"
        : "";
  const extraIconName: ThemeIconName | "" =
    info.colorblindType === "red-green"
      ? "gitea-colorblind-redgreen"
      : info.colorblindType === "blue-yellow"
        ? "gitea-colorblind-blueyellow"
        : "";
  const icon = themeSvg(svgName, iconSize);
  const extraIcon = themeSvg(extraIconName, iconSize);
  return `<div class="theme-menu-item" data-tooltip-content="${description}">${icon} ${info.displayName} ${extraIcon}</div>`;
}

// ---------------------------------------------------------------------------
// GET /-/web-theme/list (webtheme.go:18-32)
// ---------------------------------------------------------------------------

/** CurrentWebTheme (context_template.go:57-66): the signed-in doer's
 *  stored theme, else the `gitea_theme` cookie. */
async function currentThemeName(env: MiscWebEnv, request: Request, viewerKind: "anonymous" | "user", viewerId?: number): Promise<string> {
  if (viewerKind === "user" && viewerId !== undefined) {
    return (await loadUserSettings(env.DB, viewerId)).theme;
  }
  return getSiteCookie(request, COOKIE_THEME);
}

/** GuaranteeGetThemeMetaInfo (webtheme.go:252-262): the stored name, else
 *  the default, else the "unavailable" dummy (unreachable while the
 *  fallback entry exists — kept for the chain's shape). */
function resolveCurrentTheme(collection: ThemeMetaInfo[], currentName: string): ThemeMetaInfo {
  return (
    collection.find((theme) => theme.internalName === currentName) ??
    collection.find((theme) => theme.internalName === DEFAULT_WEB_THEME) ?? {
      fileName: "unavailable",
      internalName: "unavailable",
      displayName: "unavailable",
      colorblindType: "",
      colorScheme: "",
    }
  );
}

/** GET /-/web-theme/list — `{"results": [{name, value, class}]}` with the
 *  current theme's item marked `selected`. */
export async function webThemeListResponse(env: MiscWebEnv, request: Request): Promise<Response> {
  const viewer: ViewerResolution = await resolveViewer(env, request);
  const collection = await webThemeCollection(env, assetsBaseUrl(request.url));
  const current = resolveCurrentTheme(
    collection,
    await currentThemeName(env, request, viewer.viewer.kind, viewer.viewer.kind === "user" ? viewer.viewer.id : undefined),
  );
  const results = collection.map((theme) => ({
    name: renderThemeItem(theme, 14),
    value: theme.internalName,
    class: `item js-aria-clickable${theme.internalName === current.internalName ? " selected" : ""}`,
  }));
  return withSessionCookie(goJson(200, { results }), viewer.setCookie);
}

// ---------------------------------------------------------------------------
// POST /-/web-theme/apply (webtheme.go:34-42) + the CSRF check
// ---------------------------------------------------------------------------

/**
 * Go http.NewCrossOriginProtection().Check (net/http/csrf.go:130-171),
 * the zero-option protection (no trusted origins, no bypass patterns).
 * Returns the 403 http.Error deny response, or null to proceed.
 */
function crossOriginCheck(request: Request): Response | null {
  switch (request.method) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return null; // safe methods are always allowed
  }
  const secFetchSite = request.headers.get("sec-fetch-site") ?? "";
  if (secFetchSite === "same-origin" || secFetchSite === "none") return null;
  if (secFetchSite !== "") return goHttpError(403, "cross-origin request detected from Sec-Fetch-Site header");

  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return null;
  try {
    if (new URL(origin).host === (request.headers.get("host") ?? "")) return null;
  } catch {
    // unparseable Origin — fall through to the deny arm (url.Parse's
    // error path skips the equality pass upstream too)
  }
  return goHttpError(
    403,
    "cross-origin request detected, and/or browser is out of date: Sec-Fetch-Site is missing, and Origin does not match Host",
  );
}

/** ctx.FormString (query first — Go's ParseForm merges query + body with
 *  the query values first — then the urlencoded/multipart body). */
async function formString(request: Request, field: string): Promise<string> {
  const fromQuery = new URL(request.url).searchParams.get(field);
  if (fromQuery !== null) return fromQuery;
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("form-urlencoded") || contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      const value = form.get(field);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }
  return "";
}

/** POST /-/web-theme/apply — persist the theme (user_settings store for a
 *  signed-in viewer, the `gitea_theme` session cookie otherwise) and
 *  answer chi's bare 200. */
export async function webThemeApplyResponse(env: MiscWebEnv, request: Request): Promise<Response> {
  const deny = crossOriginCheck(request);
  if (deny !== null) return deny;
  const theme = await formString(request, "theme");
  const viewer: ViewerResolution = await resolveViewer(env, request);
  const headers = new Headers();
  if (viewer.setCookie !== null) headers.append("set-cookie", viewer.setCookie);
  if (viewer.viewer.kind === "user") {
    // upstream swallows the update error (`_ =`, webtheme.go:38)
    try {
      await saveUserSettings(env.DB, viewer.viewer.id, { theme });
    } catch {
      // ignored, verbatim upstream
    }
  } else {
    headers.append("set-cookie", setSiteCookie(COOKIE_THEME, theme, 0));
  }
  return new Response(null, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// POST /-/web-banner/dismiss (misc.go:82-86)
// ---------------------------------------------------------------------------

/** POST /-/web-banner/dismiss — the `gitea_disbnr` revision cookie (48h)
 *  + ctx.JSONOK's `{"ok":true}`. No gate upstream. */
export function webBannerDismissResponse(): Response {
  const response = goJson(200, { ok: true });
  const headers = new Headers(response.headers);
  headers.append(
    "set-cookie",
    setSiteCookie(COOKIE_WEB_BANNER_DISMISSED, String(WEB_BANNER_REVISION), WEB_BANNER_DISMISS_MAX_AGE_SECONDS),
  );
  return new Response(response.body, { status: response.status, headers });
}

// ---------------------------------------------------------------------------
// POST /-/markup (markup.go:16-20 + common/markup.go RenderMarkup)
// ---------------------------------------------------------------------------

/** structs.MarkupOption (modules/structs/miscellaneous.go:23-42) — the
 *  four zero-able fields the bind produces. */
interface MarkupOptionForm {
  text: string;
  mode: string;
  context: string;
  wiki: boolean;
}

const ZERO_MARKUP_OPTION: MarkupOptionForm = { text: "", mode: "", context: "", wiki: false };

/** The struct keys, exact → case-insensitive (Go's JSON decode). */
function markupOptionKey(rawKey: string): "Text" | "Mode" | "Context" | "Wiki" | null {
  for (const key of ["Text", "Mode", "Context", "Wiki"] as const) {
    if (key === rawKey) return key;
  }
  const lower = rawKey.toLowerCase();
  for (const key of ["Text", "Mode", "Context", "Wiki"] as const) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

/**
 * The JSON bind arm (binding.go:206-210): case-insensitive keys, unknown
 * keys ignored, and Go's STREAMING abort on a type mismatch — fields
 * decoded before the bad one stay set, everything after stays zero. An
 * empty body binds nothing without error (the io.EOF arm); unparseable
 * JSON zeroes the form (the all-or-nothing JSON.parse reduction of the
 * decode error — documented in the module header).
 */
function bindMarkupOptionJson(raw: string): MarkupOptionForm {
  const option: MarkupOptionForm = { ...ZERO_MARKUP_OPTION };
  if (raw.trim() === "") return option;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return option;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return option;
  for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
    const key = markupOptionKey(rawKey);
    if (key === null) continue;
    if (key === "Wiki") {
      if (typeof value !== "boolean") break;
      option.wiki = value;
    } else {
      if (typeof value !== "string") break;
      if (key === "Text") option.text = value;
      else if (key === "Mode") option.mode = value;
      else option.context = value;
    }
  }
  return option;
}

/** setWithProperType's bool arm (binding.go:363-372): "on" is true, the
 *  empty string false, strconv.ParseBool's true-set true; an invalid
 *  value is a binding error and the field STAYS false. */
function parseGoFormBool(raw: string): boolean {
  if (raw === "on") return true;
  if (raw === "") return false;
  return ["1", "t", "T", "TRUE", "true", "True"].includes(raw);
}

/**
 * The form bind arm (binding.go:197-205): urlencoded and multipart both
 * bind the SNAKE_CASE field names (ToSnakeCase — `text`, `mode`,
 * `context`, `wiki`); exact keys only (the map lookup is exact — an
 * uppercase form key does not bind). Any other content type (and a
 * broken body) leaves the ZERO form — the legacy bind-error path never
 * short-circuits (module header).
 */
async function bindMarkupOption(request: Request): Promise<MarkupOptionForm> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("json")) {
    try {
      return bindMarkupOptionJson(await request.text());
    } catch {
      return { ...ZERO_MARKUP_OPTION };
    }
  }
  if (contentType.includes("form-urlencoded") || contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      const stringField = (name: string): string => {
        const value = form.get(name);
        return typeof value === "string" ? value : "";
      };
      return {
        text: stringField("text"),
        mode: stringField("mode"),
        context: stringField("context"),
        wiki: parseGoFormBool(stringField("wiki")),
      };
    } catch {
      return { ...ZERO_MARKUP_OPTION };
    }
  }
  return { ...ZERO_MARKUP_OPTION };
}

/** RedirectForLogin (base.go:161-169) onto the landed login family's
 *  `/login` (the SPEC-0010 §2.1 adaptation): the fetch-action probe takes
 *  the 401 JSON arm, everything else Go's 303 redirect. */
function redirectForLogin(request: Request): Response {
  const url = new URL(request.url);
  const location = `/login?redirect_to=${encodeURIComponent(url.pathname + url.search)}`;
  if (isFetchActionRequest(request)) {
    return new Response(JSON.stringify({ redirect: location }), {
      status: 401,
      headers: { "content-type": "application/json;charset=utf-8" },
    });
  }
  return new Response(null, { status: 303, headers: { location } });
}

/** POST /-/markup — bind, render through the landed renderer service, and
 *  write the fragment with Go's sniffed Content-Type + the general CSP
 *  (markup.go:34 — set before the mode dispatch, so both error arms carry
 *  it too; XFO rides upstream's tree-wide SecurityHeadersHandler, nosniff
 *  http.Error's). */
export async function markupResponse(env: MiscWebEnv, request: Request): Promise<Response> {
  const viewer: ViewerResolution = await resolveViewer(env, request);
  if (viewer.viewer.kind === "anonymous") {
    return withSessionCookie(redirectForLogin(request), viewer.setCookie);
  }
  const attachCookie = (response: Response): Response => withSessionCookie(response, viewer.setCookie);
  const option = await bindMarkupOption(request);
  const mode = option.wiki ? "wiki" : option.mode === "" ? "markdown" : option.mode;
  const headers = new Headers({
    "content-security-policy": PAGE_CONTENT_SECURITY_POLICY,
    "x-frame-options": X_FRAME_OPTIONS,
  });
  try {
    const html = renderMarkdownToHtml({
      text: option.text,
      mode,
      context: option.context,
      wiki: false,
      origin: new URL(request.url).origin,
    });
    headers.set("content-type", goDetectContentType(html));
    headers.append("x-content-type-options", X_CONTENT_TYPE_OPTIONS);
    return attachCookie(new Response(html, { status: 200, headers }));
  } catch (error) {
    const errorArm = (status: number, message: string): Response => {
      // ctx.HTTPError — the exact message carries (markup.go's default
      // branch via the service; the 500 "failed to render markup" arm).
      const plain = goHttpError(status, message);
      const errorHeaders = new Headers(plain.headers);
      errorHeaders.set("content-security-policy", PAGE_CONTENT_SECURITY_POLICY);
      errorHeaders.set("x-frame-options", X_FRAME_OPTIONS);
      return new Response(plain.body, { status: plain.status, headers: errorHeaders });
    };
    if (error instanceof ApiError) return attachCookie(errorArm(error.status, error.message));
    return attachCookie(errorArm(500, "failed to render markup"));
  }
}

// ---------------------------------------------------------------------------
// The sub-app — a plain Hono seam (the well-known.ts shape). Every route
// rides `.all` + an in-handler method dispatch: chi has NO HEAD fallback,
// and Hono's auto-HEAD would strip the deliberate 405 shape's (empty)
// body — the well-known.ts header carries the full rationale.
// ---------------------------------------------------------------------------

export const webMiscRouter = new Hono<{ Bindings: MiscWebEnv }>();

// POST /-/markup (web.go:544 — reqSignIn inside the handler).
webMiscRouter.all("/-/markup", async (c) => {
  if (c.req.method === "POST") return markupResponse(c.env, c.req.raw);
  return chiMethodNotAllowed(c.req.method, ["POST"]);
});

// POST /-/web-banner/dismiss (web.go:545 — ungated).
webMiscRouter.all("/-/web-banner/dismiss", (c) => {
  if (c.req.method === "POST") return webBannerDismissResponse();
  return chiMethodNotAllowed(c.req.method, ["POST"]);
});

// GET /-/web-theme/list (web.go:546 — ungated).
webMiscRouter.all("/-/web-theme/list", async (c) => {
  if (c.req.method === "GET") return webThemeListResponse(c.env, c.req.raw);
  return chiMethodNotAllowed(c.req.method, ["GET"]);
});

// POST /-/web-theme/apply (web.go:547 — crossOriginProtect inside the
// handler, then the persistence arms).
webMiscRouter.all("/-/web-theme/apply", async (c) => {
  if (c.req.method === "POST") return webThemeApplyResponse(c.env, c.req.raw);
  return chiMethodNotAllowed(c.req.method, ["POST"]);
});
