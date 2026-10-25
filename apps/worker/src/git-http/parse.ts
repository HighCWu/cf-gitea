/**
 * Git smart-HTTP route/request parsing — SPEC-0003 §2.1-§2.3.
 *
 * The gate intercepts the four git-protocol routes of the §2.1 table
 * (`info/refs`, `git-upload-pack`, `git-receive-pack`, `HEAD`) via
 * `parseGitHttpRoute`; since the §2.1 gate-scope widening it ALSO claims the
 * repository-scoped engine JSON/admin paths for D1-resolved repositories via
 * `parseEngineRoute` (see gate.ts). Everything else parses as "not claimed"
 * and passes through to the engine verbatim, keeping the engine's behavior
 * for malformed/reserved/other paths unchanged.
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

// ---------------------------------------------------------------------------
// Engine JSON/admin paths (SPEC-0003 §2.1 gate-scope widening)
// ---------------------------------------------------------------------------

/**
 * What a repository-scoped ENGINE path asks for, as far as the gate is
 * concerned: the JSON content API is a read family, the admin shapes are
 * mutating (decided with the matrix WRITE row set).
 */
export type EngineRouteKind = "api" | "admin";

export interface EngineRoute {
  /** Decoded owner path segment (request casing; D1 lookups fold case). */
  owner: string;
  /** Decoded repo segment with exactly one trailing `.git` trimmed. */
  repo: string;
  kind: EngineRouteKind;
}

/** The engine's reserved first-segment set (packages/git-engine mod.ts, not
 *  exported by the package declarations — kept as a literal, same policy as
 *  REPO_NAME above). Reserved owners never reach the engine's authorize hook
 *  (site-level handlers / a pre-auth 404), so they are not ours to gate. */
const ENGINE_RESERVED = new Set([
  "api",
  "cgit.css",
  "favicon.ico",
  "robots.txt",
  "info",
  "git-upload-pack",
  "git-receive-pack",
]);

/**
 * Parse a repository-scoped ENGINE path — the shapes the engine serves PAST
 * its authorize hook in headless mode (`ui: false`, packages/git-engine
 * `mod.ts` `classify`): the JSON content API (`/api/*`, all methods — the DO
 * answers 405 for non-GET after auth) and the admin/mutating shapes (PUT
 * `config`, PUT `description`, POST `gc`, DELETE of the repo root). Every
 * OTHER sub-path either is one of the four git routes (`parseGitHttpRoute`),
 * the LFS family (`parseLfsRoute`), or a page/unknown shape the engine 404s
 * BEFORE its authorize hook (`!ui && !isProtocol && !isApi && !isAdmin`) —
 * those return null and stay passthrough: no repository state can leak
 * through a shape the engine answers without consulting the registry.
 *
 * Tail matching runs on the RAW (still percent-encoded) tail, because the
 * engine string-compares the URLPattern wildcard group verbatim (verified
 * against the WHATWG algorithm: group values are not percent-decoded; the
 * URL parser resolves dot-segments before matching, which both sides see
 * identically through `new URL(req.url).pathname`). The DECODED tail is
 * checked as fail-closed insurance: if a runtime ever decoded the group, an
 * encoded `api%2F…`/`con%66ig` tail must still be claimed for a D1-resolved
 * repo, never fall through. Undecodable escapes return null — they cannot be
 * api/admin-shaped under either decoding semantics, so the engine's pre-auth
 * 404 answers them.
 */
export function parseEngineRoute(pathname: string, method: string): EngineRoute | null {
  const segments = pathname.split("/");
  // "/owner/repo[/tail]" → ["", owner, repo, ...tail]
  if (segments.length < 3) return null;
  const rawOwner = segments[1];
  const rawName = segments[2];
  if (!rawOwner || !rawName) return null;

  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(rawOwner);
    name = decodeURIComponent(rawName);
  } catch {
    return null; // engine repoPath 404s undecodable owner/name pre-auth
  }
  if (!REPO_NAME.test(owner) || !REPO_NAME.test(name)) return null;
  if (ENGINE_RESERVED.has(owner)) return null;

  // The repo name carries the same `.git` trim as the git routes (§4.4).
  const repo = name.endsWith(".git") ? name.slice(0, -4) : name;

  // Repo-root shapes: sub "/" per the engine's router (a missing or empty
  // wildcard). DELETE is the engine's wipe; every other method is a page
  // shape the engine 404s pre-auth.
  const rawTail = segments.slice(3).join("/");
  if (rawTail === "") return method === "DELETE" ? { owner, repo, kind: "admin" } : null;

  let decodedTail: string | null;
  try {
    decodedTail = decodeURIComponent(rawTail);
  } catch {
    decodedTail = null; // see docstring: pre-auth 404 territory, not ours
  }
  const candidates = decodedTail !== null && decodedTail !== rawTail ? [rawTail, decodedTail] : [rawTail];
  const isApiTail = (tail: string): boolean => tail.startsWith("api/");
  const isAdminTail = (tail: string): boolean =>
    ((tail === "config" || tail === "description") && method === "PUT") || (tail === "gc" && method === "POST");

  if (candidates.some((tail) => isAdminTail(tail))) return { owner, repo, kind: "admin" };
  if (candidates.some((tail) => isApiTail(tail))) return { owner, repo, kind: "api" };
  return null;
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
