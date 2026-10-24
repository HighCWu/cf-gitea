/**
 * Org-service errors — SPEC-0007 §2/§4. Each carries the HTTP status and the
 * exact upstream message the API surface must return (SPEC-0004 §2.5
 * error-body convention); the future route batches map them 1:1. Messages are
 * byte-exact ports of the vendored upstream errclasses at the pin.
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";

export class OrgError extends Error {
  /** HTTP status the API surface must respond with. */
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = "OrgError";
    this.status = status;
  }
}

/**
 * 404 — upstream `ErrOrgNotExist` (models/organization/org.go:22–38):
 * "org does not exist [id: %d, name: %s]". Covers both the missing row and
 * the §4.11 type mismatch (`GET /orgs/{user}`) — org-scoped lookups are
 * 404-shaped for plain users, never user-shaped.
 */
export class OrgNotExistError extends OrgError {
  constructor(scope: { id?: number; name?: string } = {}) {
    super(404, `org does not exist [id: ${scope.id ?? 0}, name: ${scope.name ?? ""}]`);
    this.name = "OrgNotExistError";
  }
}

/**
 * 422 — upstream `ErrNameCharsNotAllowed` (models/db/name.go:55–68):
 * "name is invalid [%s]: must be valid alpha or numeric or dash(-_) or dot
 * characters". Raised when the username validity pattern fails.
 */
export class OrgNameCharsInvalidError extends OrgError {
  constructor(name: string) {
    super(422, `name is invalid [${name}]: must be valid alpha or numeric or dash(-_) or dot characters`);
    this.name = "OrgNameCharsInvalidError";
  }
}

/**
 * 422 — upstream `ErrNameReserved` (models/db/name.go:15–28):
 * "name is reserved [name: %s]". The reserved list is load-bearing
 * (SPEC-0007 §4.1 — an org named `org` or `invite` breaks routing).
 */
export class OrgNameReservedError extends OrgError {
  constructor(name: string) {
    super(422, `name is reserved [name: ${name.toLowerCase()}]`);
    this.name = "OrgNameReservedError";
  }
}

/**
 * 422 — upstream `ErrNamePatternNotAllowed` (models/db/name.go:35–48):
 * "name pattern is not allowed [pattern: %s]" (pattern only, no name).
 */
export class OrgNamePatternNotAllowedError extends OrgError {
  constructor(pattern: string) {
    super(422, `name pattern is not allowed [pattern: ${pattern}]`);
    this.name = "OrgNamePatternNotAllowedError";
  }
}

/**
 * 422 — service-level sanity check for the `CreateOrgOption.UserName`
 * `binding:"MaxSize(40)"` cap (modules/structs/org.go:46–48; SPEC-0007
 * §4.12: enforce in the zod schemas when the T2 create body lands, and as a
 * column sanity check now). Upstream has no service-level error for this —
 * the binding rejects at parse time.
 */
export const MAX_ORG_NAME_LENGTH = 40;

export class OrgNameTooLongError extends OrgError {
  constructor(name: string) {
    super(422, `username is too long [name: ${name}] (max ${MAX_ORG_NAME_LENGTH})`);
    this.name = "OrgNameTooLongError";
  }
}

/**
 * 409 — name taken in the shared user/org namespace. Upstream
 * `ErrUserAlreadyExist` (models/user/error.go:12–31): "user already exists
 * [name: %s]" — one `users` table means usernames and org slugs can never
 * collide (SPEC-0007 §3.1), so the create-path error is upstream's
 * user-exists error, not an org-specific one.
 */
export class OrgNameCollisionError extends OrgError {
  constructor(name: string) {
    super(409, `user already exists [name: ${name}]`);
    this.name = "OrgNameCollisionError";
  }
}

/**
 * 404 — membership target does not exist. Upstream `ErrUserNotExist`
 * (models/user/error.go:33–62): "user does not exist [uid: %d, name: %s]".
 * (Upstream's FK-less `AddOrgUser` would insert blindly; our `org_members`
 * FKs to users.id, so the service pre-checks.)
 */
export class OrgMemberUserNotExistError extends OrgError {
  constructor(scope: { id?: number; name?: string } = {}) {
    super(404, `user does not exist [uid: ${scope.id ?? 0}, name: ${scope.name ?? ""}]`);
    this.name = "OrgMemberUserNotExistError";
  }
}

/**
 * 500 — removing/demoting the only `role='owner'` member is refused.
 * Upstream `ErrLastOrgOwner` (models/organization/org.go:42–57): "user is
 * the last member of owner team [uid: %d]". SPEC-0007 §4.3 pins the mapping
 * to upstream's: the API routes it through `APIErrorInternal` → 500, not a
 * 4xx (routers/api/v1/org/member.go:338–343) — mirror, do not beautify.
 */
export class LastOrgOwnerError extends OrgError {
  constructor(userId: number) {
    super(500, `user is the last member of owner team [uid: ${userId}]`);
    this.name = "LastOrgOwnerError";
  }
}
