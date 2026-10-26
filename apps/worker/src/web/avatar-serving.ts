import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import { renderIdenticonPng } from "../services/avatar-identicon";
import {
  avatarLinkWithSize,
  generateEmailAvatarFinalLink,
  getEmailForHash,
} from "../services/avatars";

/**
 * The public avatar serving seam — the surveyed web family `GET /avatar/*`,
 * `/user/avatar/*` (docs/compat/ui-parity-survey.md:160, the "by-hash public
 * serving read" arm the avatar batch d7f5646 left open) plus its storage
 * backend `/avatars/*`. These are WEB routes, not /api/v1 ops: upstream
 * mounts them on the web mux (gitea/routers/web/web.go:265, 760, 775), the
 * frozen OpenAPI contract has no operations for them, and the traffic is the
 * browser dereferencing <img src> URLs — so this is a plain Hono sub-app,
 * outside the zod-openapi tier, serving anonymous GETs like upstream.
 *
 * Routes (upstream cite → port):
 *
 *   GET, HEAD /avatars/*                web.go:265 avatarStorageHandler
 *               (routers/web/base.go:25-94) — the object store handler over
 *               the REPO_PACKS `avatars/` prefix. cf-gitea's keys are
 *               `avatars/u_<users.id>` (user AND org rows), the repo
 *               `storage_key`s, and the generated `avatars/<HashAvatar>` files
 *               (services/avatars.ts) — upstream's ServeDirect arm is
 *               inapplicable (the R2 binding serves bytes directly, no
 *               presigned URL), so the local Open-and-serve arm is the port.
 *   GET       /avatar/{hash}            web.go:775 AvatarByEmailHash
 *               (routers/web/user/avatar.go:38-47) — hash → email → final
 *               link redirect chain (services/avatars.ts
 *               getEmailForHash/generateEmailAvatarFinalLink).
 *   GET       /user/avatar/{username}/{size}   web.go:760 AvatarByUsernameSize
 *               (routers/web/user/avatar.go:24-35) — the user fast link,
 *               AvatarLinkWithSize (models/user/avatar.go:49-79).
 *
 * Caching headers (mission item 3), upstream cites:
 *
 *   - Redirects (both /avatar routes): `cacheableRedirect`
 *     (routers/web/user/avatar.go:15-21) sets `Cache-Control: private,
 *     max-age=300` — deliberately NOT the 6h StaticCacheTime ("we must make
 *     sure the redirection cache time is short enough, otherwise a user won't
 *     see the updated avatar"), then ctx.Redirect → 303 See Other
 *     (services/context/base.go:157, http.StatusSeeOther default) with Go's
 *     text/html anchor body (net/http.Redirect).
 *   - Stored objects: `httpcache.SetCacheControlInHeader(...,
 *     CacheControlForPublicStatic())` (base.go:91) — prod form `public,
 *     max-age=21600` (httpcache.go:32-39 + StaticCacheTime = 6h,
 *     modules/setting/server.go:254), then http.ServeContent semantics:
 *     Content-Type from the stored metadata, Last-Modified and the
 *     If-Modified-Since 304 arm (second precision). Documented divergence:
 *     ServeContent's Range/If-Range handling is not ported — avatars load as
 *     whole images; the body streams from R2.
 *   - The missing-object fallback: Content-Type image/png + the
 *     HandleGenericETagPublicCache arm (base.go:36-44) — ETag + Last-Modified
 *     + `public, max-age=21600`, 304 on If-None-Match, else a seeded 96px
 *     identicon for GET and bare headers for HEAD (RandomImageWithSize(96,
 *     path), base.go:41). Upstream's ETag is `"avatar-<exeModTime>"` (a
 *     per-build timestamp, base.go:28-29); a Worker has no executable
 *     mtime and the seeded PNG is deterministic per path, so a fixed ETag is
 *     the correct stand-in (the image cannot go stale).
 *
 * 500s: upstream renders its HTML error page (ctx.ServerError) — this seam
 * answers a plain text 500 (there is no error-page engine at this layer).
 *
 * INTEGRATION (orchestrator-owned — src/index.ts, untouched here): the fetch
 * dispatcher's repo-scoped branch (`segments.length >= 2`) currently hands
 * these paths to gitHttpGate, which 404s them via the headless engine. Wire:
 *
 *     import { avatarServingRouter } from "./web/avatar-serving";
 *     // in fetch(), beside the isRepoScoped computation:
 *     const isAvatarServing = segments[0] === "avatar" ||
 *       segments[0] === "avatars" ||
 *       (segments[0] === "user" && segments[1] === "avatar");
 *     if (isRepoScoped && !isAvatarServing) { ...gate... }
 *     // and before the uiRouter mount (single-segment namespaces must not
 *     // reach the UI's /:owner/:repo parser):
 *     app.route("/", avatarServingRouter);
 *
 * The UI-side integration (commit pages/user cards emitting /avatar/<hash>
 * links) is the ui wave's — nothing is wired into src/ui here per the brief.
 */

/** CacheControlForPublicStatic's prod wire form (httpcache.go:32-39, 63-68;
 * StaticCacheTime = 6h, modules/setting/server.go:254). */
const PUBLIC_STATIC_CACHE_CONTROL = "public, max-age=21600";
/** cacheableRedirect's prod wire form (routers/web/user/avatar.go:15-21). */
const REDIRECT_CACHE_CONTROL = "private, max-age=300";
/** base.go:29 fallbackEtag — `"avatar-<exeModTime>"` shape, fixed (header). */
const FALLBACK_ETAG = '"avatar-cf-gitea-1"';
/** base.go:28 exeModTime stand-in for the fallback Last-Modified (header). */
const FALLBACK_LAST_MODIFIED = "Thu, 01 Jan 2026 00:00:00 GMT";
/** base.go:41 — RandomImageWithSize(96, avatarPath). */
const FALLBACK_IDENTICON_SIZE = 96;

/** Go's http.Error: text/plain + nosniff + trailing newline. */
function textError(status: 400 | 404 | 500, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

/**
 * cacheableRedirect (routers/web/user/avatar.go:15-21) + ctx.Redirect
 * (services/context/base.go:150-159) + net/http.Redirect: 303 See Other,
 * `private, max-age=300`, the anchor body for GET (Go's exact shape).
 */
function cacheableRedirect(location: string, isHead: boolean): Response {
  return new Response(isHead ? null : `<a href="${htmlEscape(location)}">See Other</a>.\n\n`, {
    status: 303,
    headers: {
      "Cache-Control": REDIRECT_CACHE_CONTROL,
      Location: location,
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Go html.EscapeString for the redirect anchor body. */
function htmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;");
}

/**
 * strconv.Atoi's int-returning uses (base_form.go:50, base_path.go:40-43):
 * optional sign + decimal digits, error → 0 (including overflow).
 */
function atoiPort(raw: string): number {
  if (!/^[+-]?\d{1,10}$/.test(raw)) return 0;
  const value = Number.parseInt(raw, 10);
  return Math.abs(value) > 2_147_483_647 ? 0 : value;
}

/** httpcache.checkIfNoneMatchIsValid (httpcache.go:44-62): list compare with
 * weak-prefix stripping and the `*` wildcard. */
function ifNoneMatchMatches(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  const bare = etag.startsWith("W/") ? etag.slice(2) : etag;
  for (const item of trimmed.split(",")) {
    const candidate = item.trim().startsWith("W/") ? item.trim().slice(2) : item.trim();
    if (candidate === bare) return true;
  }
  return false;
}

/**
 * util.PathJoinRelX for the single cut element (modules/util/path.go:74-83):
 * backslashes become slashes, then path.Clean over "/"-rooted segments —
 * "."s drop, ".."s pop (root-clamped), the result is relative. "" or "." →
 * the base.go:62 404 arm.
 */
export function cleanAvatarPath(input: string): string {
  const replaced = input.replaceAll("\\", "/");
  const stack: string[] = [];
  for (const segment of (`/${replaced}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      stack.pop(); // path.Clean clamps ".." at the root ("/.." == "/")
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

export const avatarServingRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET, HEAD /avatars/* — the avatarStorageHandler port (web.go:265,
// routers/web/base.go:25-94)
// ---------------------------------------------------------------------------

avatarServingRouter.on(["GET", "HEAD"], "/avatars/*", async (c) => {
  const url = new URL(c.req.url);
  const prefix = "/avatars/";
  if (!url.pathname.startsWith(prefix)) {
    return textError(400, "invalid avatar path"); // base.go:57-59 CutPrefix arm
  }
  let rest = url.pathname.slice(prefix.length);
  try {
    rest = decodeURIComponent(rest); // Go's r.URL.Path is the decoded path
  } catch {
    // a malformed escape stays raw — the cleaner treats it as opaque bytes
  }
  // cleanAvatarPath is the PathJoinRelX port over the decoded remainder.
  // Platform note: workerd's URL parser folds dot segments (literal AND
  // percent-encoded) while building the Request — Go's net/http keeps them
  // raw — so live traffic reaches the cleaner pre-folded; the ".." arms stay
  // as defense-in-depth for any host that preserves them.
  const cleaned = cleanAvatarPath(rest);
  if (cleaned === "" || cleaned === ".") {
    return textError(404, "not found"); // base.go:62-64
  }

  const object = await c.env.REPO_PACKS.get(`avatars/${cleaned}`);
  if (object === null) {
    // handleError's ErrNotExist arm (base.go:36-44): image/png + the generic
    // ETag public cache, then the seeded 96px identicon for GET.
    const headers: Record<string, string> = {
      "Content-Type": "image/png",
      "Cache-Control": PUBLIC_STATIC_CACHE_CONTROL,
      ETag: FALLBACK_ETAG,
      "Last-Modified": FALLBACK_LAST_MODIFIED,
    };
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch !== undefined && ifNoneMatchMatches(ifNoneMatch, FALLBACK_ETAG)) {
      return new Response(null, { status: 304, headers });
    }
    if (c.req.method === "HEAD") {
      return new Response(null, { status: 200, headers }); // "just return the headers"
    }
    const png = await renderIdenticonPng(FALLBACK_IDENTICON_SIZE, new TextEncoder().encode(cleaned));
    return new Response(new Blob([png.bytes]), { status: 200, headers });
  }

  // The found arm (base.go:80-92): cache-control, ServeContent semantics.
  const headers: Record<string, string> = {
    "Cache-Control": PUBLIC_STATIC_CACHE_CONTROL,
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Last-Modified": object.uploaded.toUTCString(),
    "Content-Length": String(object.size),
  };
  // http.ServeContent's If-Modified-Since arm (modtime, second precision).
  const ifModifiedSince = c.req.header("if-modified-since");
  if (ifModifiedSince !== undefined) {
    const since = Date.parse(ifModifiedSince);
    if (!Number.isNaN(since) && Math.floor(object.uploaded.getTime() / 1000) * 1000 <= since) {
      return new Response(null, { status: 304, headers });
    }
  }
  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers }); // stream, unbounded
});

// ---------------------------------------------------------------------------
// GET /avatar/{hash} — the AvatarByEmailHash port (web.go:775,
// routers/web/user/avatar.go:38-47): hash → email (services/avatars.ts
// getEmailForHash — the email_hash table note lives there), size from the
// form (FormInt, base_form.go:50 — error → 0), then the final-link
// cacheable redirect.
// ---------------------------------------------------------------------------

avatarServingRouter.on(["GET", "HEAD"], "/avatar/:hash", async (c) => {
  const email = getEmailForHash(c.req.param("hash"));
  const size = atoiPort(c.req.query("size") ?? "");
  const location = await generateEmailAvatarFinalLink(email, size);
  return cacheableRedirect(location, c.req.method === "HEAD");
});

// ---------------------------------------------------------------------------
// GET /user/avatar/{username}/{size} — the AvatarByUsernameSize port
// (web.go:760, routers/web/user/avatar.go:24-35). Upstream checks
// GetSystemUserByName first (ghost et al.) — cf-gitea has no system user
// rows, so the D1 lookup by lower_name (GetUserByName,
// models/user/user.go) is the whole resolution; upstream answers a miss
// with ctx.ServerError → 500 (the error-page divergence, module header).
// ---------------------------------------------------------------------------

avatarServingRouter.on(["GET", "HEAD"], "/user/avatar/:username/:size", async (c) => {
  const username = c.req.param("username");
  const rows = await drizzle(c.env.DB)
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      avatarEmail: users.avatarEmail,
      useCustomAvatar: users.useCustomAvatar,
    })
    .from(users)
    .where(eq(users.usernameLower, username.toLowerCase()))
    .limit(1);
  const user = rows[0];
  if (user === undefined) {
    return textError(500, "server error"); // ctx.ServerError("GetUserByName", err)
  }
  const size = atoiPort(c.req.param("size")); // PathParamInt, base_path.go:40-43
  const location = await avatarLinkWithSize(c.env.REPO_PACKS, user, size);
  return cacheableRedirect(location, c.req.method === "HEAD");
});
