/**
 * Upstream-faithful response shapes for the git-HTTP gate — SPEC-0003 §2.2/§2.4.
 *
 * Bodies and headers are ported from the vendored pin
 * (`gitea/routers/web/repo/githttp.go`, `gitea/services/context/base.go`):
 * git-HTTP errors are plain text (never JSON), the 401 challenge realm is
 * `Basic realm="Gitea"` (SPEC-0002 §2.6 pins the GCM-compatible realm even
 * though OAuth2 is absent), and protocol/cacheable responses carry the
 * no-cache triple.
 */

import type { GitHttpOp, GitHttpRoute } from "./parse";

/** `setHeaderNoCache` (githttp.go:317-321), shared by HEAD-file responses. */
export const NO_CACHE_HEADERS: Record<string, string> = {
  expires: "Fri, 01 Jan 1980 00:00:00 GMT",
  pragma: "no-cache",
  "cache-control": "no-cache, max-age=0, must-revalidate",
};

/** `Base.plainTextInternal` (services/context/base.go:130-139). */
function plainText(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff", ...headers },
  });
}

/**
 * 401 authentication challenge (upstream sets `WWW-Authenticate` then
 * `HTTPError(401)`, githttp.go:146-160 + base.go:105-111 → `http.Error`
 * appends the trailing newline).
 */
export function basicChallenge(): Response {
  return plainText(401, "Unauthorized\n", { "www-authenticate": 'Basic realm="Gitea"' });
}

/** `PlainText(404, "Repository not found")` (githttp.go:198/211) — no newline. */
export function repositoryNotFound(): Response {
  return plainText(404, "Repository not found");
}

/**
 * Missing token scope for the requested op — `CheckRepoScopedToken` →
 * `HTTPError(403)` (services/context/permission.go:79-83 → base.go:105-111).
 * Plain 403, deliberately no `WWW-Authenticate` (identity was established).
 */
export function scopeForbidden(): Response {
  return plainText(403, "Forbidden\n");
}

/** Prohibited doer account (githttp.go:180-183). */
export function accountDisabled(): Response {
  return plainText(403, "Your account is disabled.");
}

/** Prohibited repo owner, checked for every caller (githttp.go:117-119). */
export function ownerUnavailable(): Response {
  return plainText(403, "Repository cannot be accessed. You cannot push or open issues/pull-requests.");
}

/** Push to an archived repository (githttp.go:124-128). Enforced from the
 *  SPEC-0003 M2 migration that adds `repositories.is_archived`. */
export function repositoryArchived(): Response {
  return plainText(403, "This repo is archived. You can view files and clone it, but cannot push or open issues/pull-requests.");
}

/**
 * Protocol-level 400: upstream writes the bare status code with no body and
 * no Content-Type (githttp.go:82-84 unknown service, :376-381 content-type
 * mismatch, :400-403 malformed gzip).
 */
export function bareBadRequest(): Response {
  return new Response(null, { status: 400 });
}

/** Failure-limited caller (SPEC-0002 §2.7): plain 403, no challenge, so
 *  credential prompts stop. Status + Retry-After are pinned; body is not. */
export function rateLimited(retryAfterSeconds: number): Response {
  return plainText(403, "too many authentication failures, retry later\n", {
    "retry-after": String(Math.max(1, retryAfterSeconds)),
  });
}

/**
 * `?go-get=1` short-circuit (SPEC-0003 §2.1 item 1): 200 meta served without
 * auth and regardless of repo existence. Port of
 * `EarlyResponseForGoGetMeta` (services/context/repo.go:406-417) +
 * `ComposeGoGetImport`/`ComposeHTTPSCloneURL` (models/repo/repo.go:613-614):
 * import = `<host>/<owner>/<repo>`, clone = `<origin>/<owner>/<repo>.git`,
 * whole content HTML-escaped inside the attribute, owner/repo path-escaped.
 */
export function goGetMeta(url: URL, owner: string, repo: string): Response {
  const escapePath = (segment: string): string => encodeURIComponent(segment).replaceAll("%40", "@");
  const htmlEscape = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;").replaceAll('"', "&#34;");
  const importPath = `${url.host}/${escapePath(owner)}/${escapePath(repo)}`;
  const cloneUrl = `${url.origin}/${escapePath(owner)}/${escapePath(repo)}.git`;
  return plainText(200, `<meta name="go-import" content="${htmlEscape(`${importPath} git ${cloneUrl}`)}">`);
}

/**
 * Synthetic `GET /:owner/:repo(.git)?/HEAD` (route table row 4): the unborn
 * or resolved HEAD, `text/plain`, no-cache triple (§2.2).
 */
export function headFile(target: string): Response {
  return new Response(`ref: ${target}\n`, {
    status: 200,
    headers: { "content-type": "text/plain", ...NO_CACHE_HEADERS },
  });
}

/** Route-kind → op mapping, shared by the gate and the ACL layer. */
export function routeOp(kind: GitHttpRoute["kind"]): GitHttpOp {
  return kind === "receive-pack" ? "write" : "read";
}
