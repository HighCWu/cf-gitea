/**
 * Git smart-HTTP route/request parsing — SPEC-0003 §2.1-§2.3.
 *
 * The gate intercepts exactly the four git-protocol routes of the §2.1 table
 * (`info/refs`, `git-upload-pack`, `git-receive-pack`, `HEAD`); everything
 * else parses as "not a git route" and passes through to the engine verbatim,
 * keeping the engine's behavior for malformed/reserved/other paths unchanged.
 *
 * Segment handling mirrors the engine's namespaced router
 * (`packages/git-engine` URLPattern `/:owner/:name{.git}?{/*}?`):
 * `decodeURIComponent` per segment (undecodable → not a git route), exactly
 * one trailing `.git` trimmed (§4.4 — repo names ending `.git` are reserved,
 * so the trim is unambiguous), and the engine's repository-name alphabet as
 * a cheap pre-filter so the gate never claims a path the engine would 404.
 */

/** The four git-protocol sub-routes the gate owns (SPEC-0003 §2.1 table). */
export type GitHttpRouteKind = "info-refs" | "upload-pack" | "receive-pack" | "head";

/** What the request asks the repository for: upload-pack/fetch = read,
 *  receive-pack/push = write (admin ops never occur on git routes). */
export type GitHttpOp = "read" | "write";

export interface GitHttpRoute {
  /** Decoded owner path segment (request casing; D1 lookups fold case). */
  owner: string;
  /** Decoded repo segment with exactly one trailing `.git` trimmed. */
  repo: string;
  kind: GitHttpRouteKind;
}

/** Engine `REPO_NAME` (packages/git-engine mod.ts) — not exported by the
 *  package's public declarations, so kept as a literal here. A mismatch only
 *  risks routing a request to the engine that the engine would 404 anyway. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse a repository-scoped pathname into a git-HTTP route, or null when the
 * path is not one of the four git routes (→ engine passthrough). The tail
 * after `/:owner/:repo[.git]` must be exactly the route literal — anything
 * else (deeper paths, encoded lookalikes, trailing junk) is the engine's.
 */
export function parseGitHttpRoute(pathname: string): GitHttpRoute | null {
  const segments = pathname.split("/");
  // "/owner/repo/<tail>" → ["", owner, repo, ...tail]; tail must be one of
  // the known literals ("info/refs" spans two raw segments).
  if (segments.length < 4) return null;
  const rawOwner = segments[1];
  const rawName = segments[2];
  const tail = segments.slice(3).join("/");
  if (rawOwner === undefined || rawName === undefined) return null;

  const kind: GitHttpRouteKind | null =
    tail === "info/refs"
      ? "info-refs"
      : tail === "git-upload-pack"
        ? "upload-pack"
        : tail === "git-receive-pack"
          ? "receive-pack"
          : tail === "HEAD"
            ? "head"
            : null;
  if (kind === null) return null;

  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(rawOwner);
    name = decodeURIComponent(rawName);
  } catch {
    return null; // undecodable escapes: the engine 404s these, so pass through
  }
  if (!REPO_NAME.test(owner) || !REPO_NAME.test(name)) return null;

  // Trim exactly one trailing ".git", case-sensitive like upstream
  // (`strings.TrimSuffix`, githttp.go:96; §4.4).
  const repo = name.endsWith(".git") ? name.slice(0, -4) : name;
  return { owner, repo, kind };
}

/** Instance default branch (SPEC-0003 §2.5.1); the D1 `default_branch`
 *  column arrives with the M2 lifecycle migration. */
export const DEFAULT_BRANCH = "main";

/**
 * Resolve the `info/refs` service to an op (§2.1 item 2). `null` = missing or
 * unknown service (including the excluded `git-upload-archive`) → bare 400,
 * matching upstream's service switch (githttp.go:72-84).
 */
export function infoRefsOp(url: URL): GitHttpOp | null {
  const service = url.searchParams.get("service");
  if (service === "git-upload-pack") return "read";
  if (service === "git-receive-pack") return "write";
  return null;
}

type RouteWithOp = Exclude<GitHttpRouteKind, "info-refs">;

/** Exact request Content-Type for RPC POSTs (§2.3, githttp.go:376-381). */
export function rpcRequestContentType(kind: RouteWithOp): string {
  return `application/x-git-${kind}-request`;
}

/**
 * `safeGitProtocolHeader` (githttp.go:339-341): the `Git-Protocol` header is
 * forwarded to the engine only when it matches upstream's strict regex; a
 * non-matching value is dropped (it is the v0/v2 negotiation switch).
 */
export const SAFE_GIT_PROTOCOL_HEADER = /^[0-9a-zA-Z]+=[0-9a-zA-Z]+(:[0-9a-zA-Z]+=[0-9a-zA-Z]+)*$/;

/** Upstream special-cases exactly `Content-Encoding: gzip` (githttp.go:397). */
export function isGzipEncoded(req: Request): boolean {
  return (req.headers.get("content-encoding") ?? "").trim().toLowerCase() === "gzip";
}
