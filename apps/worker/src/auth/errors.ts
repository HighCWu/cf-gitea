/**
 * Auth service errors — SPEC-0002 §2.3/§4. Each carries the HTTP status and
 * the exact upstream message the API surface must return; the router maps
 * them 1:1 without inventing copies.
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AuthError extends Error {
  /** HTTP status the API surface must respond with. */
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/** 400 "access token name has been used already" (user/app.go:108–113). */
export class TokenNameExistsError extends AuthError {
  constructor() {
    super(400, "access token name has been used already");
    this.name = "TokenNameExistsError";
  }
}

/** 400 `invalid access token scope provided: …` (user/app.go:115–120). */
export class InvalidTokenScopeError extends AuthError {
  constructor(cause: string) {
    super(400, `invalid access token scope provided: ${cause}`);
    this.name = "InvalidTokenScopeError";
  }
}

/** 400 "access token must have a scope" (user/app.go:121–126). */
export class EmptyTokenScopeError extends AuthError {
  constructor() {
    super(400, "access token must have a scope");
    this.name = "EmptyTokenScopeError";
  }
}

/** 403 "cannot create an access token with a broader scope than the
 *  authenticating token" (user/app.go:138–143). */
export class TokenScopeEscalationError extends AuthError {
  constructor() {
    super(403, "cannot create an access token with a broader scope than the authenticating token");
    this.name = "TokenScopeEscalationError";
  }
}

/** 400 — token name longer than the SPEC-0002 §4.4 limit. */
export class TokenNameTooLongError extends AuthError {
  constructor(maxLength: number) {
    super(400, `access token name must be at most ${maxLength} characters`);
    this.name = "TokenNameTooLongError";
  }
}

/** 500 — prefix stayed unique-constraint-violating after the retries
 *  (SPEC-0002 §4.5; astronomically unlikely). */
export class TokenPrefixCollisionError extends AuthError {
  constructor() {
    super(500, "could not generate a unique token prefix after retries");
    this.name = "TokenPrefixCollisionError";
  }
}
