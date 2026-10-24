/**
 * Token-management API — SPEC-0002 §2.3 (compat surface).
 *
 * Mirrors upstream `/users/{username}/tokens` wiring (api.go:1060–1071):
 * `tokenRequiresScopes(user)` at the group level, context-user assignment,
 * `reqSelfOrAdmin`, `reqBasicOrRevProxyAuth` (reduced to Basic — no reverse-
 * proxy auth, SPEC-0002 §4.6.9), with `reqToken` on the mutating routes.
 * The GET route carries no `reqToken` upstream — an anonymous caller is
 * rejected by `reqSelfOrAdmin` (403), not 401 — and that ordering is kept.
 *
 * Wave 3 mounts this with one line:
 *   app.route("/api/v1", tokenRouter)
 */

import { Hono } from "hono";

import type { AuthEnv, AuthToken } from "./auth-context";
import {
  apiErrorNotFound,
  apiErrorResponse,
  requireBasicAuth,
  requireContextUser,
  requireScope,
  requireSelfOrAdmin,
  requireToken,
} from "./middleware";
import { scopeStringSlice } from "./scopes";
import { AuthError } from "./errors";
import { TokenService } from "./token-service";

/**
 * Upstream response shape (`gitea/modules/structs/user_app.go:12–27`). The
 * plaintext value travels in the misleadingly-named `sha1` field and only on
 * the mint response; list items carry `""` there, exactly like upstream.
 *
 * `token_last_eight` is the last 8 chars of the stored prefix — the 8 hex
 * chars inside the minted plaintext — so the value is identical at mint and
 * list time while staying derivable from D1 columns (SPEC-0002 §3 resolves
 * the schema/prose tension this way; plaintext last-8 are never stored).
 */
export interface AccessTokenJSON {
  id: number;
  name: string;
  sha1: string;
  token_last_eight: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
}

export function tokenToJSON(token: AuthToken, plaintext: string | null): AccessTokenJSON {
  return {
    id: token.id,
    name: token.name,
    sha1: plaintext ?? "",
    token_last_eight: token.prefix.slice(-8),
    scopes: scopeStringSlice(token.scopes),
    created_at: token.createdAt.toISOString(),
    last_used_at: token.lastUsedAt === null ? null : token.lastUsedAt.toISOString(),
  };
}

// Upstream paging defaults: page ≥ 1, default page size 30, max 50
// (routers/api/v1/utils/page.go + setting.API DefaultPagingNum/MaxResponseItems).
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 50;

export function listOptions(c: { req: { query(key: string): string | undefined } }): { page: number; pageSize: number } {
  const page = Math.max(Number.parseInt(c.req.query("page") ?? "", 10) || 0, 1);
  const rawPageSize = Number.parseInt(c.req.query("limit") ?? "", 10) || 0;
  const pageSize = rawPageSize <= 0 ? DEFAULT_PAGE_SIZE : Math.min(rawPageSize, MAX_PAGE_SIZE);
  return { page, pageSize };
}

function isAuthErrorMappingNeeded(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

export const tokenRouter = new Hono<AuthEnv>();

// Group-level scope requirement — upstream wraps the users group in
// tokenRequiresScopes(AccessTokenScopeCategoryUser).
tokenRouter.use("/users/:username/tokens", requireScope("user"));
tokenRouter.use("/users/:username/tokens/*", requireScope("user"));

const tokens = new Hono<AuthEnv>();
tokens.use("*", requireContextUser(), requireSelfOrAdmin(), requireBasicAuth());

// GET /users/{username}/tokens — paged list (no reqToken, matching upstream).
tokens.get("/", async (c) => {
  const service = new TokenService(c.env.DB);
  const contextUser = c.get("contextUser");
  const { page, pageSize } = listOptions(c);
  const { tokens: rows, total } = await service.list(contextUser.id, page, pageSize);
  return c.json(rows.map((row) => tokenToJSON(row, null)), 200, { "X-Total-Count": String(total) });
});

// POST /users/{username}/tokens — create; plaintext returned exactly once.
tokens.post("/", requireToken(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiErrorResponse(c, 422, "[Body]: invalid JSON body");
  }
  if (body === null || typeof body !== "object") {
    return apiErrorResponse(c, 422, "[Name]: Required");
  }
  const { name, scopes } = body as { name?: unknown; scopes?: unknown };
  if (typeof name !== "string" || name === "") {
    // Mirrors upstream's binding error format `[FieldNames]: Error`
    // (api.go:838–847) for the required `name` field.
    return apiErrorResponse(c, 422, "[Name]: Required");
  }
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string"))) {
    return apiErrorResponse(c, 422, "[Scopes]: must be an array of strings");
  }
  const scopeInput = Array.isArray(scopes) ? (scopes as string[]).join(",") : "";

  const auth = c.get("auth");
  const service = new TokenService(c.env.DB);
  try {
    const minted = await service.mint({
      userId: c.get("contextUser").id,
      name,
      scopes: scopeInput,
      mintedByScope: auth?.token?.scopes ?? null,
    });
    return c.json(tokenToJSON(minted, minted.plaintext), 201);
  } catch (error) {
    if (isAuthErrorMappingNeeded(error)) {
      return apiErrorResponse(c, error.status, error.message);
    }
    throw error;
  }
});

// DELETE /users/{username}/tokens/{id} — revoke by numeric id, falling back
// to name lookup when the segment is not an id (upstream app.go:195–219).
tokens.delete("/:id", requireToken(), async (c) => {
  const service = new TokenService(c.env.DB);
  const contextUser = c.get("contextUser");
  const raw = c.req.param("id");
  const parsed = Number.parseInt(raw, 10);
  let targetId = Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : 0;

  if (targetId === 0) {
    // Name lookup: 0 matches → 404, ambiguous name → 422 (upstream).
    const matches = await service.findByName(contextUser.id, raw);
    if (matches.length === 0) return apiErrorNotFound(c);
    if (matches.length > 1) {
      return apiErrorResponse(c, 422, `multiple matches for token name '${raw}'`);
    }
    targetId = matches[0]?.id ?? 0;
  }

  const deleted = await service.revoke(contextUser.id, targetId);
  if (!deleted) {
    return apiErrorNotFound(c);
  }
  return c.body(null, 204);
});

tokenRouter.route("/users/:username/tokens", tokens);
