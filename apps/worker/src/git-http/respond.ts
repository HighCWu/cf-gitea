/**
 * Upstream-faithful response shapes for the git-HTTP gate — SPEC-0003 §2.2/§2.4.
 *
 * Bodies and headers are ported from the vendored pin
 * (`gitea/routers/web/repo/githttp.go`, `gitea/services/context/base.go`):
 * git-HTTP errors are plain text, the 401 challenge realm follows the pin's
 * OAuth2 switch (below), and protocol/cacheable responses carry the
 * no-cache triple.
 */

import type { GitHttpOp, GitHttpRoute } from "./parse";

/** `setHeaderNoCache` (githttp.go:317-321), shared by HEAD-file responses. */
export const NO_CACHE_HEADERS: Record<string, string> = {
  expires: "Fri, 01 Jan 1980 00:00:00 GMT",
  pragma: "no-cache",
  "cache-control": "no-cache, max-age=0, must-revalidate",
};

/**
 * The 401 challenge realm — the pin's OAuth2 switch (githttp.go:146-159),
 * now CONDITIONAL on the provider (SPEC specs/oauth2-provider.md §2.11's
 * flip): with the provider enabled (the `OAUTH2_ENABLED` var, default true
 * = upstream's `setting.OAuth2.Enabled` default), the challenge answers
 * `Basic realm="Gitea"`, which tells GCM to attempt its BUILT-IN OAUTH2
 * APPLICATION (git-credential-manager#1442 — the seeded builtin
 * applications make the attempt land); the disabled arm deliberately
 * answers `Basic realm="Gitea (Basic Auth)"` — "If OAuth2 is disabled, then
 * use another realm to avoid GCM OAuth2 attempt" — so credential managers
 * fall back to prompting instead of looping on an OAuth2 endpoint that
 * does not exist.
 */
export const OAUTH2_BASIC_CHALLENGE = 'Basic realm="Gitea"';
/** The disabled arm — the pre-provider constant, kept verbatim. */
export const BASIC_AUTH_CHALLENGE = 'Basic realm="Gitea (Basic Auth)"';

/**
 * 401 authentication challenge (upstream sets `WWW-Authenticate` then
 * `HTTPError(401)`, githttp.go:146-160 + base.go:105-111 → `http.Error`
 * appends the trailing newline). The realm follows the pin's OAuth2 switch:
 * provider enabled ⇒ OAUTH2_BASIC_CHALLENGE, disabled ⇒ BASIC_AUTH_CHALLENGE.
 * Callers pass the strict-polarity gate read (`oauth2FeatureEnabled(env)`).
 */
export function basicChallenge(oauth2Enabled: boolean): Response {
  return plainText(401, "Unauthorized\n", { "www-authenticate": oauth2Enabled ? OAUTH2_BASIC_CHALLENGE : BASIC_AUTH_CHALLENGE });
}

/** `Base.plainTextInternal` (services/context/base.go:130-139). */
function plainText(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff", ...headers },
  });
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
 * Row 13 / §2.5.3: a renamed (or transferred) repository's old URL answers
 * `301` to the canonical path, preserving the `.git` suffix, the sub-route
 * tail and the query string — BEFORE any auth challenge (githttp.go:117-119,
 * `LookupRedirect` at services/context/repo.go:420-436; the ordering is
 * required by git clients, per the upstream test comment at
 * tests/integration/git_smart_http_test.go:139).
 *
 * `nameSuffix` carries the wiki family's `.wiki` marker (the git-http gate's
 * wiki branch): a renamed parent's `/{owner}/{old}.wiki.git/...` URL keeps
 * pointing at the SIBLING cell at the canonical name —
 * `/{owner}/{new}.wiki.git/...` — instead of silently re-targeting the
 * parent's code URL. (Upstream's own wiki redirect lands on the parent's web
 * page, RedirectToRepo — the tail is lost; ours is the tail-preserving fabric
 * every other row-13 redirect runs, with the marker re-attached.)
 */
export function redirectPermanent(
  originalUrl: string,
  ownerNamespace: string,
  slug: string,
  nameSuffix = "",
): Response {
  const source = new URL(originalUrl);
  const target = new URL(source.origin);
  // Raw (still-encoded) path: ["", owner, repo(.git)?, ...tail]. The `.git`
  // suffix and the tail are preserved verbatim so git clients re-request the
  // identical resource at the canonical location (§2.5.3).
  const segments = source.pathname.split("/");
  const repoSegment = segments[2] ?? "";
  const gitSuffix = repoSegment.endsWith(".git") ? ".git" : "";
  const tail = segments.slice(3).join("/");
  target.pathname = `/${encodeURIComponent(ownerNamespace)}/${encodeURIComponent(slug)}${nameSuffix}${gitSuffix}${tail ? `/${tail}` : ""}`;
  target.search = source.search;
  return new Response(`Moved Permanently\n`, {
    status: 301,
    headers: { location: target.toString(), "content-type": "text/plain;charset=utf-8" },
  });
}

/**
 * The vendored engine's registry-miss 404 for git-protocol reads
 * (packages/git-engine `mod.ts`: `repository not found: ${repo}\n`, plain
 * 404) — the exact not-found the D1-missing read passthrough has always
 * surfaced for unknown names. The gate's registry-existence oracle
 * (gitHttpGate's unknown-repository branch) answers this itself, byte-identical,
 * so a deleted repository's read is decided WITHOUT reaching the engine —
 * whose per-isolate registry memo (`infoMemo`, 20 s positive TTL) otherwise
 * resurrects the deleted repo's refs on the isolate that served its last
 * pre-delete read (the REDEPLOY10/11 production probe's ~5.4-6.4 s
 * read-after-delete window on a renamed repo's new name).
 */
export function engineRepoNotFound(engineName: string): Response {
  return new Response(`repository not found: ${engineName}\n`, { status: 404 });
}

/**
 * The same registry miss in the engine's JSON API shape (`mod.ts` `/api/*`
 * arm: `{ error: "repository not found: ${repo}" }`, 404,
 * `x-content-type-options: nosniff`) for the engine-path branch's D1-missing
 * api reads — the same memo-staleness leak class, one surface over.
 */
export function engineJsonRepoNotFound(engineName: string): Response {
  return Response.json({ error: `repository not found: ${engineName}` }, {
    status: 404,
    headers: { "x-content-type-options": "nosniff" },
  });
}

/**
 * Dummy empty advertisement for the push-create probe (§2.2/§2.4 rows 15-20,
 * upstream `dummyInfoRefs` githttp.go:268-300): the exact bytes a fresh empty
 * repository would advertise for receive-pack — `# service=` pkt-line, flush,
 * `<zero-oid> capabilities^{}` with the engine's receive capability set, flush —
 * so the client believes the repo exists and sends zero-id create commands
 * (§2.5.2; no protocol special-casing needed).
 */
export function dummyAdvertisement(): Response {
  const zeroOid = "0".repeat(40);
  // pkt-line payload: 40 oid + space + 15 "capabilities^{}" + NUL + caps + LF
  // MIRRORS the engine's receive capability list (src/git/protocol.ts
  // advertisement(), git-receive-pack branch) — this probe path stands in for
  // a fresh empty repo's advertisement, so the client's capability-dependent
  // decisions (--atomic, --push-option) must see the same support the real
  // advertisement carries. Update both together.
  const capabilities = "report-status report-status-v2 delete-refs side-band-64k atomic ofs-delta push-options object-format=sha1 agent=dgit/0.3";
  const payload = `${zeroOid} capabilities^{}\0${capabilities}\n`;
  const pkt = (s: string): string => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
  const body = `${pkt("# service=git-receive-pack\n")}0000${pkt(payload)}0000`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-git-receive-pack-advertisement", ...NO_CACHE_HEADERS },
  });
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
