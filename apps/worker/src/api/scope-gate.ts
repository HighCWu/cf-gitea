/**
 * Tree-wide token-scope gate for `/api/v1` — the MOUNTING half of upstream's
 * `tokenRequiresScopes` (auth-parity H1, docs/usability/parity-review-auth.md
 * §4 / drift 1). The check semantics live in SPEC-0002's port
 * (`requireScope`, src/auth/middleware.ts:216-234, itself a byte-port of
 * api.go:271-305); this module carries the GROUP TABLE upstream hangs those
 * checks on and evaluates it per request.
 *
 * Upstream shape being mirrored (routers/api/v1/api.go:1009-1872 at pin
 * fc493688): chi groups wrap route subtrees in `tokenRequiresScopes(...)`,
 * and the categories are a property of the GROUP a path lands in — including
 * the sibling-group subtleties chi gives for free:
 *   - the issue-family subtrees under /repos/{owner}/{repo} (issues, labels,
 *     milestones, projects, /repos/issues/search) sit in a SIBLING
 *     `/repos` group gated `issue` (api.go:1692-1714) — the repo-scope gate
 *     of the main /repos group (api.go:1554) does NOT apply to them;
 *   - /repos/{owner}/{repo}/notifications is its own sibling group gated
 *     `notification` (api.go:1686-1690);
 *   - /users/{username}/orgs is a sibling of the two other /users groups and
 *     is gated `user` AND `organization` (api.go:1718-1721), while every
 *     other /users path is gated plain `user` (api.go:1049-1096);
 *   - /user carries nested ADDITIONS: /user/repos and /user/starred also
 *     need `repository` (api.go:1181, 1184-1190), /user/projects also
 *     `issue` (api.go:1103-1105), /user/orgs also `organization`
 *     (api.go:1716-1717) — chi nests these inside the user-scope group, so
 *     BOTH categories are required;
 *   - /orgs/{org}/repos carries the repository gate on its POST/DELETE arms
 *     only (api.go:1731, 1733 — the sibling GET stays organization-only);
 *   - the deprecated POST /org/{org}/repos gate lists BOTH categories in ONE
 *     call (api.go:1224-1229) — upstream `HasScope` is all-of, so the token
 *     needs organization AND repository (the same rule our ScopeSet.has
 *     implements, auth/scopes.ts:119-128).
 *
 * The first matching row wins; its categories are the COMPLETE requirement
 * for that path (sibling-group semantics). Requests are evaluated with the
 * method-derived level exactly like upstream (api.go:285-289: POST, PUT,
 * PATCH, DELETE ⇒ write, else read). Every requirement in the table is
 * upstream's own; no category was chosen by hand for a path upstream gates.
 *
 * NOT gated (upstream leaves them outside every tokenRequiresScopes group):
 *   - the misc group: /version, /signing-key.*, /markup, /markdown*,
 *     /gitignore/templates*, /licenses*, /label/templates*, /settings/*
 *     (api.go:1002-1027);
 *   - the /token introspection combo (api.go:1030-1032, reqToken only);
 *   - /packages/{username}* (api.go:1700-1714) — gated INSIDE
 *     routes/packages.ts (requirePackageContext's groupScopeGate arm, which
 *     also carries the reqPackageAccess stack the bare category gate cannot
 *     express); mounting a second copy here would double-evaluate, so the
 *     row is deliberately absent;
 *   - /activitypub/* (api.go:1008) — federation is a recorded gap
 *     (parity review §9; the upstream route is NotImplemented anyway).
 *
 * Anonymous requests and requests whose credential is NOT a token pass —
 * upstream returns early when `GetDoerTokenScope` reports no token scope
 * (api.go:281-283); the route's own reqToken / repoAssignment gates own the
 * anonymous decision. A token whose stored scope misses the requirement
 * answers upstream's exact 403 body (api.go:300, Go `%v` slice rendering);
 * `no-token-scope` tokens parse to an empty bitmap and therefore fail every
 * gated path, as upstream.
 */

import type { MiddlewareHandler } from "hono";

import type { AuthInfo } from "../auth/auth-context";
import { requiredScopeNames, type ScopeCategory, type ScopeLevel } from "../auth/scopes";
import type { ApiEnv } from "./env";
import { ApiError } from "./errors";

/** One upstream chi group: the path family it gates and its categories. */
interface ScopeGroupRow {
  /** Path shape relative to the `/api/v1` mount (anchored). */
  readonly pattern: RegExp;
  /** The complete tokenRequiresScopes category list for the family. */
  readonly categories: readonly ScopeCategory[];
  /** When set, the row applies only to these HTTP methods. */
  readonly methods?: readonly string[];
  /** The upstream cite (api.go lines) this row implements. */
  readonly cite: string;
}

/**
 * The group table, in evaluation order. Sibling-group overrides (issue /
 * notification subtrees, /users/{username}/orgs) must precede their broader
 * fallback rows; nested additions encode BOTH categories in one row.
 */
const SCOPE_GROUP_ROWS: readonly ScopeGroupRow[] = [
  // --- /repos tree (three sibling chi groups over one URL space) ------------
  { pattern: /^\/repos\/issues(?:\/|$)/, categories: ["issue"], cite: "api.go:1692-1693 (/repos/issues/search)" },
  {
    pattern: /^\/repos\/[^/]+\/[^/]+\/(?:issues|labels|milestones|projects)(?:\/|$)/,
    categories: ["issue"],
    cite: "api.go:1692-1714 (issue group: issues/labels/milestones/projects)",
  },
  {
    pattern: /^\/repos\/[^/]+\/[^/]+\/notifications(?:\/|$)/,
    categories: ["notification"],
    cite: "api.go:1686-1690 (repo notifications sibling group)",
  },
  { pattern: /^\/repos(?:\/|$)/, categories: ["repository"], cite: "api.go:1234-1554 (repo group)" },
  { pattern: /^\/repositories(?:\/|$)/, categories: ["repository"], cite: "api.go:1231-1232 (GET /repositories/{id})" },

  // --- /users + /user trees -------------------------------------------------
  {
    pattern: /^\/users\/[^/]+\/orgs(?:\/|$)/,
    categories: ["user", "organization"],
    cite: "api.go:1718-1721 (users orgs sibling group)",
  },
  {
    pattern: /^\/users\/[^/]+\/repos(?:\/|$)/,
    categories: ["user", "repository"],
    cite: "api.go:1075 (GET /users/{username}/repos, nested)",
  },
  {
    pattern: /^\/users\/[^/]+\/projects(?:\/|$)/,
    categories: ["user", "issue"],
    cite: "api.go:1076-1077 (GET /users/{username}/projects, nested)",
  },
  { pattern: /^\/users(?:\/|$)/, categories: ["user"], cite: "api.go:1049-1096 (both /users groups)" },
  {
    pattern: /^\/user\/orgs(?:\/|$)/,
    categories: ["user", "organization"],
    cite: "api.go:1716-1717 (GET /user/orgs)",
  },
  {
    pattern: /^\/user\/repos(?:\/|$)/,
    categories: ["user", "repository"],
    cite: "api.go:1181 (user repos combo, nested)",
  },
  {
    pattern: /^\/user\/starred(?:\/|$)/,
    categories: ["user", "repository"],
    cite: "api.go:1184-1190 (user starred group, nested)",
  },
  {
    pattern: /^\/user\/projects(?:\/|$)/,
    categories: ["user", "issue"],
    cite: "api.go:1103-1105 (user projects group, nested)",
  },
  { pattern: /^\/user(?:\/|$)/, categories: ["user"], cite: "api.go:1097-1217 (/user group)" },

  // --- /orgs + /teams --------------------------------------------------------
  {
    pattern: /^\/orgs\/[^/]+\/repos(?:\/|$)/,
    categories: ["organization", "repository"],
    methods: ["POST", "DELETE"],
    cite: "api.go:1731,1733 (org repos create/delete arms)",
  },
  {
    pattern: /^\/orgs\/[^/]+\/projects(?:\/|$)/,
    categories: ["organization", "issue"],
    cite: "api.go:1774-1776 (org projects group, nested)",
  },
  { pattern: /^\/orgs(?:\/|$)/, categories: ["organization"], cite: "api.go:1723-1813 (/orgs tree)" },
  { pattern: /^\/teams(?:\/|$)/, categories: ["organization"], cite: "api.go:1814-1841 (/teams/{teamid} group)" },
  {
    pattern: /^\/org\/[^/]+\/repos(?:\/|$)/,
    categories: ["organization", "repository"],
    cite: "api.go:1224-1229 (deprecated POST /org/{org}/repos — one gate, all-of)",
  },

  // --- remaining gated groups ------------------------------------------------
  { pattern: /^\/notifications(?:\/|$)/, categories: ["notification"], cite: "api.go:1044-1051 (/notifications group)" },
  { pattern: /^\/admin(?:\/|$)/, categories: ["admin"], cite: "api.go:1842-1876 (/admin group)" },
  { pattern: /^\/topics(?:\/|$)/, categories: ["repository"], cite: "api.go:1871-1873 (/topics/search)" },
];

/** The mount prefix the production worker puts this sub-app under. The
 *  standalone-router usage (tests, embedding) mounts the same families at
 *  the root, so the strip is OPTIONAL and exact-segment. */
const MOUNT_PREFIX = /^\/api\/v1(?=\/|$)/;

/** Upstream's write methods (api.go:287-289). */
function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function matchRow(path: string, method: string): ScopeGroupRow | null {
  for (const row of SCOPE_GROUP_ROWS) {
    if (row.methods !== undefined && !row.methods.includes(method)) continue;
    if (row.pattern.test(path)) return row;
  }
  return null;
}

/**
 * The tree-wide gate. Mount ONCE at the top of `createApiRouter` (before any
 * route family registers) so it evaluates ahead of every handler, exactly
 * like chi's group middleware. See the module header for the table's
 * semantics and its deliberate gaps.
 */
export function apiScopeGate(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const relativePath = c.req.path.replace(MOUNT_PREFIX, "");
    const row = matchRow(relativePath, c.req.method);
    if (row === null) {
      await next();
      return;
    }
    // No token credential attached (anonymous, or the router runs standalone
    // without resolveAuth) → nothing to enforce here; upstream returns early
    // when no token scope exists (api.go:281-283).
    const auth: AuthInfo | undefined = c.get("auth");
    if (auth?.scope === null || auth?.scope === undefined) {
      await next();
      return;
    }
    const level: ScopeLevel = isWriteMethod(c.req.method) ? "write" : "read";
    const required = requiredScopeNames(level, row.categories);
    if (!auth.scope.has(...required)) {
      // Byte-identical to requireScope's body (auth/middleware.ts:226-231,
      // api.go:300) — the {message, url} envelope renders through
      // giteaErrorHandler, whose url equals the auth module's swaggerUrl.
      const tokenScope = auth.token?.scopes ?? "";
      throw new ApiError(
        403,
        `token does not have at least one of required scope(s), required=[${required.join(" ")}], token scope=${tokenScope}`,
      );
    }
    await next();
  };
}
