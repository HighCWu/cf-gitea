/**
 * SPEC-0002 feature module — users, personal access tokens, scopes, auth
 * middleware, failure limiting.
 *
 * Public surface:
 * - `resolveAuth`     — credential-parsing middleware, attaches `c.var.auth`
 * - `requireToken` / `requireScope` / `requireSiteAdmin` / `requireContextUser`
 *   / `requireSelfOrAdmin` / `requireBasicAuth` / `sudo` — post-auth chain
 * - `tokenRouter`     — `/users/:username/tokens` CRUD (Wave 3 mounts it with
 *   `app.route("/api/v1", tokenRouter)`)
 * - `TokenService`, `D1FailureLimiter` / `RateLimitHook`, scope grammar
 */

export * from "./auth-context";
export {
  apiErrorNotFound,
  apiErrorResponse,
  doerTokenAllowsOwner,
  rejectPublicOnly,
  rejectPublicOnlyUserAssignment,
  requireBasicAuth,
  requireContextUser,
  requireScope,
  requireSelfOrAdmin,
  requireSiteAdmin,
  requireToken,
  resolveAuth,
  sudo,
  swaggerUrl,
  type ResolveAuthOptions,
} from "./middleware";
export { tokenRouter, tokenToJSON, type AccessTokenJSON } from "./router";
export {
  LAST_USED_THROTTLE_MS,
  MAX_TOKEN_NAME_LENGTH,
  TokenService,
  type MintTokenInput,
  type MintedToken,
  type TokenPage,
  type VerifiedAuth,
} from "./token-service";
export {
  D1FailureLimiter,
  fnv1a32,
  type FailureLimiterConfig,
  type RateLimitHook,
  type RateLimitVerdict,
} from "./failure-limiter";
export {
  InvalidScopeError,
  normalizeScope,
  requiredScopeNames,
  scopeStringSlice,
  SCOPE_ALL,
  SCOPE_CATEGORIES,
  SCOPE_NONE,
  SCOPE_PUBLIC_ONLY,
  ScopeSet,
  type ScopeCategory,
  type ScopeLevel,
} from "./scopes";
export { enforcePublicOnlyFrom } from "./scopes";
export {
  basicAuthTokenCandidate,
  parseAuthorizationHeader,
  type BasicAuth,
  type BearerToken,
  type ParsedAuthorizationHeader,
} from "./httpauth";
export { generateToken, isCfGiteaTokenShape, tokenLookupPrefix } from "./token-format";
export { sha256Hex, timingSafeDigestEqual } from "./digest";
export {
  AuthError,
  EmptyTokenScopeError,
  InvalidTokenScopeError,
  TokenNameExistsError,
  TokenNameTooLongError,
  TokenPrefixCollisionError,
  TokenScopeEscalationError,
} from "./errors";
