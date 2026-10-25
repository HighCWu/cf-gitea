import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { emailAddresses, gpgKeys, publicKeys, userRedirects, users } from "../../db/schema";
import { loadSubkeys, toApiGpgKey, toApiPublicKey } from "../services/account-keys";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { gpgKeyListSchema, gpgKeySchema } from "../models/gpg-key";
import { publicKeyListSchema, publicKeySchema } from "../models/public-key";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { findUserByName } from "../services/repository";

/**
 * The user-account key/email family on REAL D1 storage (tables of migration
 * 0016: `email_addresses`, `public_keys`, `gpg_keys` — schema.ts column notes
 * carry the upstream citations). This module is the single home for the
 * account-family ROUTES (the wave brief's "pick one home" decision): the six
 * ops the misc-t3 wave landed as empty-storage stubs (GET/DELETE
 * /user/keys[/{id}], GET/DELETE /user/gpg_keys[/{id}]) are UPGRADED in place
 * to real reads/deletes, and the write half the tables unblock lands beside
 * them. The shared
 * key/gpg row→API mappers (`toApiPublicKey`/`toApiGpgKey`/`loadSubkeys`) now
 * live in services/account-keys.ts — the consolidation this module's originals
 * and identity.ts's verbatim copies converged on (the email row mapper
 * `toApiEmail` stays here: this module is its only consumer):
 *
 *   - GET/POST/DELETE /user/emails          (userListEmails / userAddEmail /
 *                                             userDeleteEmail — routers/api/v1/
 *                                             user/email.go)
 *   - POST /user/keys                       (userCurrentPostKey — user/key.go
 *                                             CreatePublicKey → CreateUserPublicKey)
 *   - POST /user/gpg_keys                   (userCurrentPostGPGKey — user/gpg_key.go
 *                                             CreateGPGKey → CreateUserGPGKey)
 *   - GET /user/gpg_key_token               (getVerificationToken — the
 *                                             asymkey_model.VerificationToken
 *                                             sha256 formula, ported verbatim)
 *   - GET /admin/emails, GET /admin/emails/search
 *                                           (adminGetAllEmails / adminSearchEmails
 *                                             — admin/email.go over
 *                                             user_model.SearchEmails)
 *   - POST /admin/users/{username}/keys     (adminCreatePublicKey — a thin
 *                                             delegation to the SAME
 *                                             CreateUserPublicKey helper,
 *                                             admin/user.go:348)
 *   - DELETE /admin/users/{username}/keys/{id}
 *                                           (adminDeleteUserPublicKey —
 *                                             admin/user.go:352-391 over
 *                                             asymkey_service.DeletePublicKey)
 *
 * All ten are contract ops that were UNDECLARED before this change (the
 * re-enumeration's emails/keys/gpg set); the frozen-contract subset rule is
 * kept per op (declared codes ⊆ contract codes).
 *
 * ---------------------------------------------------------------------------
 * Upstream behavior ports (with the honesty boundaries of each parser):
 * ---------------------------------------------------------------------------
 *
 * SSH public keys (POST /user/keys, admin keys, the reads):
 *   upstream's parser is Go-native (`golang.org/x/crypto/ssh`,
 *   models/asymkey/ssh_key_parse.go). cf-gitea implements the provable
 *   subset: the OpenSSH single-line format (`type base64 [comment]`),
 *   structurally validated (the decoded blob must be a well-formed SSH wire
 *   string sequence whose first field names the declared type), with the
 *   upstream length caps (maxKeyBinaryBytes 4096 → 5461 base64 chars). The
 *   fingerprint is upstream's `ssh.FingerprintSHA256` — "SHA256:" +
 *   unpadded-std-base64(sha256(blob)) (ssh_key_fingerprint.go:42-48). NOT
 *   implemented (each → 422 `Invalid key content: …`): the SSH2/RFC4716
 *   headered format and PEM PKIX conversion arms of parseKeyString
 *   (ssh_key_parse.go:87-130), and minimum-key-size checks
 *   (setting.SSH.MinimumKeySizeCheck is instance config; cf-gitea runs
 *   defaults-off upstream, ssh_key_parse.go:182). Upstream's exact Go error
 *   strings after `Invalid key content: ` are runtime internals (the %v tail
 *   diverges); statuses and the prefix match.
 *
 * GPG keys (POST /user/gpg_keys, the reads):
 *   upstream parses with ProtonMail/go-crypto openpgp. cf-gitea implements
 *   the provable subset: RFC 4880 ASCII armor (CRC-24 checked when present)
 *   and a v4 packet walk — public-key (tag 6), subkey (tag 14), user-id
 *   (tag 13) and signature (tag 2) packets — yielding key_id (16 hex
 *   uppercase, low 64 bits of the SHA-1 v4 fingerprint), packet creation,
 *   algorithm capability bits (can_sign / can_encrypt_comms / can_encrypt_storage /
 *   can_certify per go-crypto's PubKeyAlgo.CanSign/CanEncrypt), the content column
 *   (base64 of the canonical `0x99 ‖ len16 ‖ body` public-key packet —
 *   upstream Base64EncPubKey/Serialize, gpg_key_common.go:52-58), identity
 *   emails and self-signature key lifetimes (subpacket type 9, last one wins
 *   — upstream prefers the IsPrimaryId self-signature; the difference is
 *   observable only on multi-self-signature keys). NOT implemented:
 *   v5/v6 key packets (→ 422 parse error), signature VERIFICATION (the
 *   `armored_signature` arm and POST /user/gpg_key_verify need RSA/DSA/EC
 *   signature checks — every supplied signature answers upstream's
 *   invalid-token-signature 422 verbatim, so no key is ever marked verified;
 *   `POST /user/gpg_key_verify` stays UNDECLARED for the same reason), and
 *   revoked-identity filtering (parseGPGKey's ident.Revoked skip). The
 *   add-time email gate IS ported: without a verified signature every
 *   identity email must match an ACTIVATED email_addresses row (or the
 *   synthesized primary below) — parseGPGKey's ErrGPGNoEmailFound 404.
 *
 *   Upstream stores subkeys as gpg_key rows with primary_key_id set
 *   (addGPGSubKey) — ported. It does NOT persist the matched emails (the
 *   GPGKey.Emails field is parse-time only and renders `[]` on every GET in
 *   this pin) — ported. `gpg_key_import` (the raw armor, used only by commit
 *   signature verification) is NOT modeled — no commit verification exists.
 *
 * Emails:
 *   upstream materializes the signup address as the is_primary row at user
 *   creation; cf-gitea keeps the primary on `users.email` (SPEC-0002 §3) and
 *   user creation (not this module) writes no row for it. The read side
 *   therefore UNIONS the primary back as a synthesized entry (is_activated,
 *   is_primary, rendered first like upstream's earliest-row order) whenever
 *   `users.email` has no email_addresses row; the add path treats it as
 *   taken (409, matching upstream's row-existence check). Known corners:
 *   DELETE of the synthesized primary answers the in-contract 404
 *   "Email address does not exist" — upstream finds its materialized row and
 *   its delete path answers an OUT-OF-CONTRACT 500 there
 *   (user/email.go:122-128 → ErrPrimaryEmailCannotDelete → APIErrorInternal);
 *   cf-gitea cannot declare or honor a 500.
 *   API-added addresses are activated immediately (upstream
 *   `!setting.Service.RegisterEmailConfirm`, default false). The email
 *   syntax check is a pragmatic RFC-5322-lite regex — upstream runs Go's
 *   net/mail.ParseAddress (helpers.go:118-131); borderline-syntax addresses
 *   may diverge, statuses/messages match (400 "email address is invalid: …").
 *
 * Admin wiring (routes carrying an /admin prefix): upstream groups run
 * `tokenRequiresScopes(admin) → reqToken() → reqSiteAdmin()` (api.go:1824-).
 * Landed seams per admin-t2.ts: reqToken → the shared requireAuth middleware
 * (runtime-only 401 — the contract declares none in this tag);
 * reqSiteAdmin → the local requireSiteAdmin (403 `user should be the site
 * admin` — contract-declared); scope gates → the standing SPEC-0002 deferral.
 * The `/users/{username}` subgroup adds `context.UserAssignmentAPI()`
 * (api.go:31-66): type-blind name lookup, the user_redirect 307 seam, else
 * 404 `user redirect does not exist [name: …]`. That miss-404 is
 * RUNTIME-ONLY-UNDECLARED for POST /admin/users/{username}/keys (the frozen
 * contract declares {201,403,422} — it is emitted anyway, exactly what
 * upstream sends; the orchestrator-granted RUNTIME_ONLY_RESPONSES table is
 * the place to record it if a grant is wanted).
 *
 * The DELETE /user/gpg_keys/{id} not-exist arm is a CORRECTION of the landed
 * stub (which answered 404 citing gpg_key.go:234-235 — that line is
 * VerifyUserGPGKey's arm, not DeleteGPGKey's): models.DeleteGPGKey returns
 * nil on ErrGPGKeyNotExist (gpg_key.go:227-233), so upstream answers 204 for
 * any id the doer does not own — the real delete below is upstream-accurate.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const unauthorizedResponse = {
  description: "unauthorized",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const conflictResponse = {
  description: "conflict",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

/** Numeric-id path param, wire-string/contract-integer per the repo convention
 *  (routes/hook-delivery.ts): any wire value reaches the handler, where the
 *  zero-key miss renders the upstream not-exist 404 (non-numeric ids behave
 *  like upstream's PathParamInt64 → 0 → ErrNotExist). */
const keyIdParam = (description: string) =>
  ({
    params: z.object({
      id: z.string().min(1).openapi({ type: "integer", format: "int64", description }),
    }),
  }) as const;

// ---------------------------------------------------------------------------
// Contract wire shapes defined in the vendored swagger but not yet needed by
// any models/ module (models/ is outside this wave's ownership — the schemas
// live here until a models/email.ts extracts them).
// ---------------------------------------------------------------------------

/** `#/definitions/Email` — upstream modules/structs/user_email.go Email. */
const emailSchema = z.object({
  email: z.string().optional().openapi({ description: "The email address", format: "email" }),
  verified: z.boolean().optional().openapi({ description: "Whether the email address has been verified" }),
  primary: z.boolean().optional().openapi({ description: "Whether this is the primary email address" }),
  user_id: z.number().int().optional().openapi({ description: "The unique identifier of the user who owns this email", format: "int64" }),
  username: z.string().optional().openapi({ description: "username of the user" }),
});

/** `#/responses/EmailList` — plain `Email[]`. */
const emailListSchema = z.array(emailSchema);

/** `#/definitions/CreateEmailOption` — upstream user_email.go. */
const createEmailOptionSchema = z.object({
  emails: z.array(z.string()).optional().openapi({ description: "email addresses to add" }),
});

/** `#/definitions/DeleteEmailOption` — upstream user_email.go. */
const deleteEmailOptionSchema = z.object({
  emails: z.array(z.string()).optional().openapi({ description: "email addresses to delete" }),
});

/** `#/definitions/CreateKeyOption` — upstream user_key.go. `read_only` is
 *  accepted-and-ignored: the user-key create path always writes
 *  AccessModeWrite (key.go AddPublicKey:151 — upstream ignores it here too). */
const createKeyOptionSchema = z.object({
  title: z.string().optional().openapi({ description: "Title of the key to add" }),
  key: z.string().optional().openapi({ description: "An armored SSH key to add" }),
  read_only: z.boolean().optional().openapi({ description: "Describe if the key has only read access or read/write" }),
});
type CreateKeyOption = z.infer<typeof createKeyOptionSchema>;

/** `#/definitions/CreateGPGKeyOption` — upstream user_gpgkey.go. */
const createGpgKeyOptionSchema = z.object({
  armored_public_key: z.string().optional().openapi({ description: "An armored GPG key to add" }),
  armored_signature: z.string().optional().openapi({ description: "An optional armored signature for the GPG key" }),
});
type CreateGpgKeyOption = z.infer<typeof createGpgKeyOptionSchema>;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const userListEmailsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/emails",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the authenticated user's email addresses",
    operationId: "userListEmails",
    responses: {
      // Contract {200} only — the group-wiring 401 is the runtime-only class
      // documented in the module header.
      200: {
        description: "EmailList",
        content: { "application/json": { schema: emailListSchema } },
      },
    },
  });

const userAddEmailRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/user/emails",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Add email addresses",
    operationId: "userAddEmail",
    request: {
      // Body optional: upstream's binder maps an absent form to the zero
      // value (nil Emails → the handler's 422 "Email list empty").
      body: { content: { "application/json": { schema: createEmailOptionSchema } }, required: false },
    },
    responses: {
      201: {
        description: "EmailList",
        content: { "application/json": { schema: emailListSchema } },
      },
      400: errorResponse,
      409: conflictResponse,
      422: validationErrorResponse,
    },
  });

const userDeleteEmailRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/emails",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Delete email addresses",
    operationId: "userDeleteEmail",
    // Body optional: an absent form is the zero value → the empty-list 204.
    request: {
      body: { content: { "application/json": { schema: deleteEmailOptionSchema } }, required: false },
    },
    responses: {
      204: { description: "empty" },
      404: notFoundResponse,
    },
  });

const userCurrentPostKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/user/keys",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Create a public key",
    operationId: "userCurrentPostKey",
    // Body optional: the Required fields are enforced by the handler's
    // binding-shaped 422s, not the validator (upstream binder behavior).
    request: {
      body: { content: { "application/json": { schema: createKeyOptionSchema } }, required: false },
    },
    responses: {
      201: {
        description: "PublicKey",
        content: { "application/json": { schema: publicKeySchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      422: validationErrorResponse,
    },
  });

const userCurrentPostGpgKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/user/gpg_keys",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Create a GPG key",
    operationId: "userCurrentPostGPGKey",
    request: {
      body: { content: { "application/json": { schema: createGpgKeyOptionSchema } }, required: false },
    },
    responses: {
      201: {
        description: "GPGKey",
        content: { "application/json": { schema: gpgKeySchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const getVerificationTokenRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/gpg_key_token",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get a Token to verify",
    operationId: "getVerificationToken",
    responses: {
      200: {
        description: "string",
        content: { "text/plain": { schema: z.string() } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const adminGetAllEmailsRoute = (requireAuth: MiddlewareHandler<ApiEnv>, requireSiteAdmin: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/admin/emails",
    middleware: [requireAuth, requireSiteAdmin],
    tags: ["admin"],
    summary: "List all emails",
    operationId: "adminGetAllEmails",
    request: listQuery,
    responses: {
      200: {
        description: "EmailList",
        content: { "application/json": { schema: emailListSchema } },
      },
      403: forbiddenResponse,
    },
  });

const adminSearchEmailsRoute = (requireAuth: MiddlewareHandler<ApiEnv>, requireSiteAdmin: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/admin/emails/search",
    middleware: [requireAuth, requireSiteAdmin],
    tags: ["admin"],
    summary: "Search all emails",
    operationId: "adminSearchEmails",
    request: {
      query: listQuery.query.extend({
        q: z.string().optional().openapi({ description: "keyword" }),
      }),
    },
    responses: {
      200: {
        description: "EmailList",
        content: { "application/json": { schema: emailListSchema } },
      },
      403: forbiddenResponse,
    },
  });

const adminCreatePublicKeyRoute = (
  requireAuth: MiddlewareHandler<ApiEnv>,
  requireSiteAdmin: MiddlewareHandler<ApiEnv>,
) =>
  createRoute({
    method: "post",
    path: "/admin/users/{username}/keys",
    middleware: [requireAuth, requireSiteAdmin],
    tags: ["admin"],
    summary: "Add a public key on behalf of a user",
    operationId: "adminCreatePublicKey",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "username of the user who is to receive a public key" }),
      }),
      body: { content: { "application/json": { schema: createKeyOptionSchema } } },
    },
    responses: {
      201: {
        description: "PublicKey",
        content: { "application/json": { schema: publicKeySchema } },
      },
      403: forbiddenResponse,
      422: validationErrorResponse,
    },
  });

const adminDeleteUserPublicKeyRoute = (
  requireAuth: MiddlewareHandler<ApiEnv>,
  requireSiteAdmin: MiddlewareHandler<ApiEnv>,
) =>
  createRoute({
    method: "delete",
    path: "/admin/users/{username}/keys/{id}",
    middleware: [requireAuth, requireSiteAdmin],
    tags: ["admin"],
    summary: "Delete a user's public key",
    operationId: "adminDeleteUserPublicKey",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "username of the user whose public key is to be deleted" }),
        id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the key to delete" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

// (existing misc-t3 declarations — the doer-scoped key reads/deletes — below)

const signingKeyGpgRoute = createRoute({
  method: "get",
  path: "/signing-key.gpg",
  tags: ["miscellaneous"],
  summary: "Get default signing-key.gpg",
  operationId: "getSigningKey",
  responses: {
    200: {
      description: "GPG armored public key",
      content: { "text/plain": { schema: z.string() } },
    },
    // Runtime-only (check-openapi.mjs RUNTIME_ONLY_RESPONSES): the only
    // reachable status without a signing-key configuration — the contract
    // documents the 200 alone. Declared so the operation's served set mirrors
    // the contract plus the one documented exception.
    404: notFoundResponse,
  },
});

const signingKeyPubRoute = createRoute({
  method: "get",
  path: "/signing-key.pub",
  tags: ["miscellaneous"],
  summary: "Get default signing-key.pub",
  operationId: "getSigningKeySSH",
  responses: {
    200: {
      description: "ssh public key",
      content: { "text/plain": { schema: z.string() } },
    },
    // Runtime-only (check-openapi.mjs RUNTIME_ONLY_RESPONSES): same story as
    // /signing-key.gpg — SigningKeySSH feeds the SSH expected format into the
    // SAME getSigningKey helper (misc/signing.go:100), so without a
    // signing-key configuration the blank-format arm answers identically.
    404: notFoundResponse,
  },
});

const userCurrentListKeysRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/keys",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the authenticated user's public keys",
    operationId: "userCurrentListKeys",
    request: {
      ...listQuery,
      query: listQuery.query.extend({
        fingerprint: z.string().optional().openapi({ description: "fingerprint of the key" }),
      }),
    },
    responses: {
      200: {
        description: "PublicKeyList",
        content: { "application/json": { schema: publicKeyListSchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
    },
  });

const userCurrentGetKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/keys/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get a public key",
    operationId: "userCurrentGetKey",
    request: keyIdParam("id of key to get"),
    responses: {
      200: {
        description: "PublicKey",
        content: { "application/json": { schema: publicKeySchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentDeleteKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/keys/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Delete a public key",
    operationId: "userCurrentDeleteKey",
    request: keyIdParam("id of key to delete"),
    responses: {
      204: { description: "empty" },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentListGpgKeysRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/gpg_keys",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the authenticated user's GPG keys",
    operationId: "userCurrentListGPGKeys",
    request: listQuery,
    responses: {
      200: {
        description: "GPGKeyList",
        content: { "application/json": { schema: gpgKeyListSchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
    },
  });

const userCurrentGetGpgKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/gpg_keys/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get a GPG key",
    operationId: "userCurrentGetGPGKey",
    request: keyIdParam("id of key to display"),
    responses: {
      200: {
        description: "GPGKey",
        content: { "application/json": { schema: gpgKeySchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentDeleteGpgKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/gpg_keys/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Remove a GPG key",
    operationId: "userCurrentDeleteGPGKey",
    request: keyIdParam("id of key to delete"),
    responses: {
      204: { description: "empty" },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

// ---------------------------------------------------------------------------
// Binary helpers (Web-standard only — workerd has no Node Buffer)
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function shaHex(algo: "SHA-1" | "SHA-256", data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algo, data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 fingerprint in ssh's rendering: "SHA256:" + unpadded std base64. */
async function sshFingerprint(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`;
}

// ---------------------------------------------------------------------------
// SSH public key parsing — the provable OpenSSH single-line subset
// (models/asymkey/ssh_key_parse.go; the module header documents the
// SSH2/PEM arms and Go error-string divergences)
// ---------------------------------------------------------------------------

/** Upstream maxKeyBinaryBytes (ssh_key_parse.go:36) → the base64 cap
 *  maxKeyContentBase64Bytes (4096 * 4 / 3). */
const SSH_MAX_KEY_BASE64_BYTES = 5461;

/** Go strings.SplitN: the last part carries the unsplit remainder. */
function goSplitN(content: string, separator: string, n: number): string[] {
  const parts = content.split(separator);
  if (parts.length <= n) {
    return parts;
  }
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(separator)];
}

interface ParsedSshKey {
  /** The normalized stored content: "type base64 [comment]" (upstream
   *  parseKeyString's return, whitespace-trimmed). */
  content: string;
  fingerprint: string;
}

/**
 * Structural OpenSSH public key validation + SHA-256 fingerprint. Throws the
 * route-mapped 422 ApiError on any violation (HandleCheckKeyStringError's
 * "Invalid key content: …" family).
 */
async function parseSshPublicKey(raw: string): Promise<ParsedSshKey> {
  let content = raw.trim();
  const invalid = (detail: string): ApiError => new ApiError(422, `Invalid key content: ${detail}`);
  if (content.startsWith("---- BEGIN SSH2 PUBLIC KEY ----") || content.includes("-----BEGIN")) {
    throw invalid("unsupported public key format (OpenSSH single-line only)");
  }
  // Upstream removes all newlines from the OpenSSH form before splitting.
  content = content.replaceAll("\r\n", "").replaceAll("\n", "");
  const parts = goSplitN(content, " ", 3);
  if (parts.length === 0 || (parts[0] ?? "") === "") {
    throw invalid("empty key");
  }
  const declaredType = parts.length === 1 ? "" : parts[0]!;
  const base64Key = parts.length === 1 ? parts[0]! : parts[1]!;
  const comment = parts.length === 3 ? parts[2]! : "";
  if (base64Key.length > SSH_MAX_KEY_BASE64_BYTES) {
    throw invalid("SSH public key base64 is too long");
  }
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(base64Key);
  } catch {
    throw invalid("invalid key format: illegal base64 data");
  }
  if (blob.length < 4) {
    throw invalid("invalid key format");
  }
  // SSH wire walk: length-prefixed strings; the first names the key type.
  const readString = (offset: number): [string, number] | null => {
    if (offset + 4 > blob.length) {
      return null;
    }
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const length = view.getUint32(offset);
    if (offset + 4 + length > blob.length) {
      return null;
    }
    return [new TextDecoder().decode(blob.subarray(offset + 4, offset + 4 + length)), offset + 4 + length];
  };
  const first = readString(0);
  if (first === null) {
    throw invalid("invalid key format: not enough length");
  }
  const [wireType, afterType] = first;
  if (declaredType !== "" && declaredType !== wireType) {
    throw invalid(`key type and content does not match: ${declaredType} - ${wireType}`);
  }
  // The remaining fields must be a clean string sequence consuming the blob
  // (a real key carries at least one material field).
  let offset = afterType;
  let fields = 0;
  while (offset < blob.length) {
    const next = readString(offset);
    if (next === null) {
      throw invalid("invalid ssh public key: malformed key blob");
    }
    offset = next[1];
    fields += 1;
  }
  if (fields === 0) {
    throw invalid("invalid ssh public key: empty key blob");
  }
  const stored = parts.length === 1 ? `${wireType} ${base64Key}` : [declaredType, base64Key, comment].filter((p) => p !== "").join(" ");
  return { content: stored.trim(), fingerprint: await sshFingerprint(blob) };
}

// ---------------------------------------------------------------------------
// GPG key parsing — the provable v4 OpenPGP subset (module header documents
// the v5/v6 and signature-verification omissions)
// ---------------------------------------------------------------------------

interface ParsedGpgSubkey {
  keyId: string;
  created: Date;
  /** Unix seconds, or null when no key lifetime is signed. */
  expires: number | null;
  content: string;
  canSign: boolean;
  canEncrypt: boolean;
}

interface ParsedGpgEntity {
  keyId: string;
  created: Date;
  expires: number | null;
  content: string;
  canSign: boolean;
  canEncrypt: boolean;
  identityEmails: string[];
  subkeys: ParsedGpgSubkey[];
}

const GPG_KEY_PACKET = 6;
const GPG_SUBKEY_PACKET = 14;
const GPG_USERID_PACKET = 13;
const GPG_SIGNATURE_PACKET = 2;

/** go-crypto's PubKeyAlgo.CanEncrypt/CanSign (packet/packet.go). */
const GPG_ENCRYPT_ALGOS = new Set([1, 2, 16, 18]);
const GPG_SIGN_ALGOS = new Set([1, 3, 17, 19, 22]);

function gpgParseError(detail: string): ApiError {
  // HandleAddGPGKeyError's IsErrGPGKeyParsing arm: err.Error() prefixes
  // "failed to parse gpg key " (error.go:134-136).
  return new ApiError(422, `failed to parse gpg key ${detail}`);
}

/** RFC 4880 §6 CRC-24 (go-crypto armor checks it when the checksum line is
 *  present). */
function crc24(data: Uint8Array): number {
  const POLY = 0x864cfb;
  let crc = 0xb704ce;
  for (const byte of data) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) {
        crc ^= POLY;
      }
    }
  }
  return crc & 0xffffff;
}

/** Decode the RFC 4880 ASCII armor (the first PUBLIC KEY BLOCK found). */
function dearmor(armored: string): Uint8Array {
  const BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
  const END = "-----END PGP PUBLIC KEY BLOCK-----";
  const begin = armored.indexOf(BEGIN);
  if (begin < 0) {
    throw gpgParseError("no armored public key block found");
  }
  const rest = armored.slice(begin + BEGIN.length);
  const end = rest.indexOf(END);
  if (end < 0) {
    throw gpgParseError("unterminated armored public key block");
  }
  const lines = rest.slice(0, end).split(/\r\n|\r|\n/);
  let i = 0;
  // RFC 4880 §6.2: key-value headers, then a blank line, then the base64 body.
  while (i < lines.length && (lines[i] ?? "").trim() !== "") {
    i += 1;
  }
  i += 1;
  const base64Lines: string[] = [];
  let checksumLine: string | null = null;
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("=")) {
      checksumLine = line;
      break;
    }
    base64Lines.push(line);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64Lines.join(""));
  } catch {
    throw gpgParseError("invalid armor encoding");
  }
  if (checksumLine !== null && checksumLine.length === 5) {
    // The checksum is base64-encoded (4 chars → the 24-bit value).
    const encoded = base64ToBytes(checksumLine.slice(1, 5));
    const expected = (encoded[0]! << 16) | (encoded[1]! << 8) | encoded[2]!;
    if (expected !== crc24(bytes)) {
      throw gpgParseError("armor checksum mismatch");
    }
  }
  return bytes;
}

interface RawPacket {
  tag: number;
  body: Uint8Array;
}

/** Walk the binary packet sequence (RFC 4880 §4.2; partial lengths are a
 *  documented-unsupported arm). */
function walkPackets(bytes: Uint8Array): RawPacket[] {
  const packets: RawPacket[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const first = bytes[offset]!;
    if ((first & 0x80) === 0) {
      throw gpgParseError("invalid packet header");
    }
    let tag: number;
    let length: number;
    let headerLength: number;
    if ((first & 0x40) === 0) {
      // Old format: 3 tag bits, 2 length-type bits.
      tag = (first >> 2) & 0x0f;
      const lengthType = first & 0x03;
      if (lengthType === 3) {
        throw gpgParseError("indeterminate packet length unsupported");
      }
      headerLength = 1 + (1 << lengthType);
      if (offset + headerLength > bytes.length) {
        throw gpgParseError("truncated packet header");
      }
      length = 0;
      for (let i = 0; i <= lengthType; i++) {
        length = length * 256 + bytes[offset + 1 + i]!;
      }
    } else {
      // New format lengths (RFC 4880 §4.2.3).
      tag = first & 0x3f;
      if (offset + 2 > bytes.length) {
        throw gpgParseError("truncated packet header");
      }
      const b1 = bytes[offset + 1]!;
      if (b1 < 192) {
        length = b1;
        headerLength = 2;
      } else if (b1 <= 223) {
        if (offset + 3 > bytes.length) {
          throw gpgParseError("truncated packet header");
        }
        length = (b1 - 192) * 256 + bytes[offset + 2]! + 192;
        headerLength = 3;
      } else if (b1 === 255) {
        if (offset + 6 > bytes.length) {
          throw gpgParseError("truncated packet header");
        }
        length = view.getUint32(offset + 2);
        headerLength = 6;
      } else {
        throw gpgParseError("partial packet lengths unsupported");
      }
    }
    const bodyStart = offset + headerLength;
    if (bodyStart + length > bytes.length) {
      throw gpgParseError("truncated packet body");
    }
    packets.push({ tag, body: bytes.subarray(bodyStart, bodyStart + length) });
    offset = bodyStart + length;
  }
  return packets;
}

/** MPI reader (RFC 4880 §3.2): 2-bit-length bytes + ceil(bits/8) octets. */
function readMpi(body: Uint8Array, offset: number): number {
  if (offset + 2 > body.length) {
    throw gpgParseError("truncated MPI");
  }
  const bits = (body[offset]! << 8) | body[offset + 1]!;
  const byteLength = Math.ceil(bits / 8);
  if (offset + 2 + byteLength > body.length) {
    throw gpgParseError("truncated MPI");
  }
  return offset + 2 + byteLength;
}

/**
 * Validate a v4 public-key packet body; returns {created, algo, canSign,
 * canEncrypt}. Algorithm-specific material walks (RSA/DSA/ElGamal MPIs,
 * ECC OIDs+points, ECDH KDF tail) per RFC 4880 §5.5.2.
 */
function parseV4PublicKeyBody(body: Uint8Array): {
  created: Date;
  algo: number;
  canSign: boolean;
  canEncrypt: boolean;
} {
  if (body.length < 6) {
    throw gpgParseError("short public key packet");
  }
  const version = body[0]!;
  if (version !== 4) {
    throw gpgParseError(`unsupported public key version ${version} (v4 only)`);
  }
  const created = new Date(
    ((body[1]! << 24) | (body[2]! << 16) | (body[3]! << 8) | body[4]!) * 1000,
  );
  const algo = body[5]!;
  let offset = 6;
  switch (algo) {
    case 1: // RSA
    case 2: // RSA encrypt-only
    case 3: // RSA sign-only
      offset = readMpi(body, offset); // n
      offset = readMpi(body, offset); // e
      break;
    case 16: // ElGamal
      offset = readMpi(body, offset); // p
      offset = readMpi(body, offset); // g
      offset = readMpi(body, offset); // y
      break;
    case 17: // DSA
      offset = readMpi(body, offset); // p
      offset = readMpi(body, offset); // q
      offset = readMpi(body, offset); // g
      offset = readMpi(body, offset); // y
      break;
    case 18: // ECDH
    case 19: // ECDSA
    case 22: // EdDSA
      offset = readMpi(body, offset); // OID
      offset = readMpi(body, offset); // point
      if (algo === 18) {
        if (offset + 1 > body.length) {
          throw gpgParseError("truncated ECDH KDF fields");
        }
        offset += 1 + body[offset]!;
      }
      break;
    default:
      throw gpgParseError(`unsupported public key algorithm ${algo}`);
  }
  if (offset !== body.length) {
    throw gpgParseError("trailing bytes in public key packet");
  }
  return { created, algo, canSign: GPG_SIGN_ALGOS.has(algo), canEncrypt: GPG_ENCRYPT_ALGOS.has(algo) };
}

/** v4 fingerprint: SHA-1 over `0x99 ‖ len16 ‖ body`; the key id is the low 64
 *  bits, hex uppercase (RFC 4880 §12.2). The canonical serialization
 *  (`0x99 ‖ len16 ‖ body`) is also upstream's stored `content`
 *  (Base64EncPubKey → packet.Serialize). */
async function v4KeyIdentity(body: Uint8Array): Promise<{ keyId: string; content: string }> {
  const framed = new Uint8Array(3 + body.length);
  framed[0] = 0x99;
  framed[1] = body.length >> 8;
  framed[2] = body.length & 0xff;
  framed.set(body, 3);
  const digestHex = await shaHex("SHA-1", framed);
  return { keyId: digestHex.slice(-16).toUpperCase(), content: bytesToBase64(framed) };
}

/** Extract the address from a user-id packet (RFC 4880 §5.11 "Name
 *  (Comment) <email>"); bare addresses pass through. */
function userIdEmail(body: Uint8Array): string | null {
  const text = new TextDecoder().decode(body).trim();
  const matches = [...text.matchAll(/<([^<>]*)>/g)];
  const last = matches[matches.length - 1];
  const candidate = (last !== undefined ? last[1] : text) ?? "";
  const trimmed = candidate.trim();
  return /^[^\s<>@]+@[^\s<>@]+$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Read the key-lifetime subpacket (type 9, RFC 4880 §5.2.3.9) from a v4
 * signature's hashed area; the LAST one found wins (upstream prefers the
 * IsPrimaryId self-signature — the module header documents the corner).
 */
function signatureLifetime(body: Uint8Array): number | null {
  if (body.length < 6 || body[0] !== 4) {
    return null; // v3 signatures carry no lifetime
  }
  const hashedLength = (body[4]! << 8) | body[5]!;
  const hashedEnd = Math.min(6 + hashedLength, body.length);
  let offset = 6;
  let lifetime: number | null = null;
  while (offset < hashedEnd) {
    let subLength: number;
    let headerLength: number;
    const b1 = body[offset]!;
    if (b1 < 192) {
      subLength = b1;
      headerLength = 1;
    } else if (b1 <= 254) {
      if (offset + 2 > hashedEnd) {
        return lifetime;
      }
      subLength = (b1 - 192) * 256 + body[offset + 1]! + 192;
      headerLength = 2;
    } else {
      if (offset + 5 > hashedEnd) {
        return lifetime;
      }
      subLength = (body[offset + 1]! << 24) | (body[offset + 2]! << 16) | (body[offset + 3]! << 8) | body[offset + 4]!;
      headerLength = 5;
    }
    const dataStart = offset + headerLength;
    if (dataStart + subLength > hashedEnd) {
      return lifetime;
    }
    if (subLength === 4 && (body[dataStart]! & 0x7f) === 9) {
      lifetime = (body[dataStart + 1]! << 24) | (body[dataStart + 2]! << 16) | (body[dataStart + 3]! << 8) | body[dataStart + 4]!;
    }
    offset = dataStart + subLength;
  }
  return lifetime;
}

/**
 * Parse an armored OpenPGP key into entities (the CheckArmoredGPGKeyString
 * subset: v4 packets only). Multi-entity armors coalesce per key id exactly
 * like upstream AddGPGKey's id2key merge (gpg_key_add.go:82-112).
 */
async function parseArmoredGpgKey(armored: string): Promise<ParsedGpgEntity[]> {
  const packets = walkPackets(dearmor(armored));
  type Owner = ParsedGpgEntity;
  const owners = new Map<string, Owner>();
  let current: Owner | null = null;
  let currentSubkey: ParsedGpgSubkey | null = null;
  for (const { tag, body } of packets) {
    if (tag === GPG_KEY_PACKET || tag === GPG_SUBKEY_PACKET) {
      const parsed = parseV4PublicKeyBody(body);
      const { keyId, content } = await v4KeyIdentity(body);
      const owner: Owner = {
        keyId,
        created: parsed.created,
        expires: null,
        content,
        canSign: parsed.canSign,
        canEncrypt: parsed.canEncrypt,
        identityEmails: [],
        subkeys: [],
      };
      if (tag === GPG_KEY_PACKET) {
        const existing = owners.get(keyId);
        // Upstream coalesces duplicate primary keys into one entity; the
        // merge keeps the first occurrence's fields and unions subkeys.
        if (existing !== undefined) {
          current = existing;
        } else {
          owners.set(keyId, owner);
          current = owner;
        }
        currentSubkey = null;
      } else {
        if (current === null) {
          throw gpgParseError("subkey before primary key");
        }
        current.subkeys.push(owner);
        currentSubkey = owner;
      }
    } else if (tag === GPG_USERID_PACKET) {
      if (current === null) {
        throw gpgParseError("user id before primary key");
      }
      const email = userIdEmail(body);
      if (email !== null && !current.identityEmails.includes(email)) {
        current.identityEmails.push(email);
      }
      currentSubkey = null;
    } else if (tag === GPG_SIGNATURE_PACKET) {
      const lifetime = signatureLifetime(body);
      if (lifetime !== null) {
        const target = currentSubkey ?? current;
        if (target !== null) {
          target.expires = target.created.getTime() / 1000 + lifetime;
        }
      }
    }
  }
  if (owners.size === 0) {
    throw gpgParseError("no public key found in armor");
  }
  return [...owners.values()];
}

// ---------------------------------------------------------------------------
// asymkey_model.VerificationToken (gpg_key_verify.go:78-86) — ported
// verbatim; only the RFC1123Z timezone is pinned to UTC (upstream uses the
// server location; the token only needs GET/verify self-consistency).
// ---------------------------------------------------------------------------

const GO_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const GO_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function goRfc1123z(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${GO_WEEKDAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${GO_MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

async function verificationToken(user: typeof users.$inferSelect, minutes: number): Promise<string> {
  const minuteStart = Math.floor(Date.now() / 60000) * 60000;
  const payload = [
    goRfc1123z(new Date(minuteStart + minutes * 60000)),
    goRfc1123z(user.createdAt),
    user.username,
    user.email ?? "",
    String(user.id),
  ].join(":");
  return shaHex("SHA-256", new TextEncoder().encode(payload));
}

/** Upstream's invalid-token-signature 422 (gpg_key.go:222-224, 320-323) —
 *  the ONLY honest answer while signature verification is unimplemented. */
function invalidTokenSignatureError(token: string): ApiError {
  return new ApiError(
    422,
    "The provided GPG key, signature and token do not match or token is out of date. Provide a valid signature for the token: " +
      token,
  );
}

// ---------------------------------------------------------------------------
// Email service half (user/email.go + services/user/email.go over
// email_addresses + the synthesized primary from users.email)
// ---------------------------------------------------------------------------

/** D1 row of `users` (schema.ts). */
type UserRow = typeof users.$inferSelect;

/** One renderable email entry: a real row or the synthesized primary. */
interface EmailEntry {
  email: string;
  isActivated: boolean;
  isPrimary: boolean;
}

/**
 * The user's email entries in upstream render order: the primary first (it is
 * the earliest row upstream — created at signup), then the rows by id. The
 * primary is SYNTHESIZED from `users.email` when no row carries it (upstream
 * materializes it at user creation; cf-gitea's user creation does not — the
 * module header documents the model).
 */
async function emailEntriesOfUser(d1: D1Database, user: UserRow): Promise<EmailEntry[]> {
  const rows = await drizzle(d1)
    .select()
    .from(emailAddresses)
    .where(eq(emailAddresses.userId, user.id))
    .orderBy(asc(emailAddresses.id));
  const entries: EmailEntry[] = rows.map((row) => ({
    email: row.email,
    isActivated: row.isActivated,
    isPrimary: row.isPrimary,
  }));
  const primaryLower = user.email?.toLowerCase();
  if (primaryLower !== undefined && primaryLower !== "" && !rows.some((row) => row.lowerEmail === primaryLower)) {
    entries.unshift({ email: user.email!, isActivated: true, isPrimary: true });
  }
  return entries;
}

/** convert.ToEmail (convert.go:47-53) — user_id/username stay zero (the
 *  upstream Email struct has no omitempty and ToEmail sets only three
 *  fields, so the wire always carries user_id: 0 / username: ""). */
function toApiEmail(entry: EmailEntry, user?: { id: number; username: string }) {
  return {
    email: entry.email,
    verified: entry.isActivated,
    primary: entry.isPrimary,
    user_id: user?.id ?? 0,
    username: user?.username ?? "",
  };
}

/** Upstream ValidateEmail (email_address.go:121-129): a syntax check plus the
 *  domain allow/block lists (both empty by default → allowed). The regex is
 *  a pragmatic RFC-5322-lite stand-in for Go's net/mail.ParseAddress — the
 *  module header documents the divergence. */
function validateEmailFormat(email: string): boolean {
  if (/[^\x21-\x7e]/.test(email)) {
    return false; // no non-ASCII / controls (upstream rejects non-ASCII too)
  }
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) {
    return false;
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length > 255) {
    return false;
  }
  if (/^[.-]|[.-]$|\.\./.test(local)) {
    return false;
  }
  if (domain.startsWith("[")) {
    return /^\[(\d{1,3}(\.\d{1,3}){3}|IPv6:[0-9a-fA-F:]+)\]$/.test(domain); // address literal
  }
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(domain);
}

/**
 * user_service.AddEmailAddresses (services/user/email.go:76-121) over the
 * cf-gitea storage: sequential validate → used-check (rows ∪ users.email ∪
 * this batch) → insert, with upstream's observable all-or-nothing batch
 * behavior (any failure inserts nothing). API-added addresses activate
 * immediately (upstream `!RegisterEmailConfirm`).
 */
async function addEmailAddresses(d1: D1Database, user: UserRow, emailsToAdd: string[]): Promise<void> {
  const db = drizzle(d1);
  const batchSeen = new Set<string>();
  const inserts: { email: string; lowerEmail: string }[] = [];
  for (const email of emailsToAdd) {
    if (!validateEmailFormat(email)) {
      throw new ApiError(400, `email address is invalid: ${email}`);
    }
    const lower = email.toLowerCase();
    if (batchSeen.has(lower)) {
      throw new ApiError(409, `e-mail already in use [email: ${email}]`);
    }
    const rowTaken =
      (await db.select({ id: emailAddresses.id }).from(emailAddresses).where(eq(emailAddresses.lowerEmail, lower)).limit(1))
        .length > 0;
    if (rowTaken) {
      throw new ApiError(409, `e-mail already in use [email: ${email}]`);
    }
    const userTaken =
      user.email !== null && user.email.toLowerCase() === lower
        ? true
        : (
            await db
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.type, "user"), sql`lower(${users.email}) = ${lower}`))
              .limit(1)
          ).length > 0;
    if (userTaken) {
      throw new ApiError(409, `e-mail already in use [email: ${email}]`);
    }
    batchSeen.add(lower);
    inserts.push({ email, lowerEmail: lower });
  }
  // Upstream wraps the batch in a transaction; cf-gitea pre-checks every
  // address above and inserts sequentially (a concurrent duplicate racer can
  // observe partial application — the unique lower_email index is the
  // arbiter either way).
  for (const insert of inserts) {
    await db
      .insert(emailAddresses)
      .values({ userId: user.id, email: insert.email, lowerEmail: insert.lowerEmail, isActivated: true, isPrimary: false });
  }
}

/**
 * user_service.DeleteEmailAddresses (services/user/email.go:130-166):
 * sequential exists-check then delete, all-or-nothing. Rows only — the
 * synthesized primary is not a row, so deleting it answers the in-contract
 * 404 (module header documents upstream's out-of-contract 500 corner).
 */
async function deleteEmailAddresses(d1: D1Database, user: UserRow, emailsToRemove: string[]): Promise<void> {
  const db = drizzle(d1);
  const targets: number[] = [];
  for (const email of emailsToRemove) {
    const lower = email.toLowerCase();
    const row = (
      await db
        .select({ id: emailAddresses.id })
        .from(emailAddresses)
        .where(and(eq(emailAddresses.userId, user.id), eq(emailAddresses.lowerEmail, lower)))
        .limit(1)
    )[0];
    if (row === undefined) {
      // ErrEmailAddressNotExist.Error() (email_address.go:44-47) — the
      // handler's 404 arm (user/email.go:123-125).
      throw new ApiError(404, `Email address does not exist [email: ${email}]`);
    }
    targets.push(row.id);
  }
  for (const id of targets) {
    await db.delete(emailAddresses).where(eq(emailAddresses.id, id));
  }
}

// ---------------------------------------------------------------------------
// Key service half (user/key.go CreateUserPublicKey + asymkey AddPublicKey,
// user/gpg_key.go CreateUserGPGKey + asymkey AddGPGKey). The row→API mappers
// (toApiPublicKey/toApiGpgKey/loadSubkeys) live in services/account-keys.ts —
// the shared account-family home this module's originals consolidated into.
// ---------------------------------------------------------------------------

/**
 * asymkey_model.AddPublicKey (ssh_key.go:123-162) reduced to the API path:
 * global fingerprint-reuse check (checkKeyFingerprint → HandleAddKeyError's
 * "Key content has been used as non-deploy key" 422) and the per-owner name
 * check ("Key title has been used" 422); Mode write / Type user / verified
 * false, created=updated=now (upstream xorm created/updated auto-columns).
 */
async function addPublicKey(d1: D1Database, owner: UserRow, form: CreateKeyOption): Promise<typeof publicKeys.$inferSelect> {
  const db = drizzle(d1);
  const parsed = await parseSshPublicKey(form.key!);
  const fingerprintTaken = await db
    .select({ id: publicKeys.id })
    .from(publicKeys)
    .where(eq(publicKeys.fingerprint, parsed.fingerprint))
    .limit(1);
  if (fingerprintTaken.length > 0) {
    throw new ApiError(422, "Key content has been used as non-deploy key");
  }
  const nameTaken = await db
    .select({ id: publicKeys.id })
    .from(publicKeys)
    .where(and(eq(publicKeys.ownerId, owner.id), eq(publicKeys.name, form.title!)))
    .limit(1);
  if (nameTaken.length > 0) {
    throw new ApiError(422, "Key title has been used");
  }
  const now = new Date();
  const inserted = await db
    .insert(publicKeys)
    .values({
      ownerId: owner.id,
      name: form.title!,
      fingerprint: parsed.fingerprint,
      content: parsed.content,
      mode: 2,
      type: 1,
      loginSourceId: 0,
      verified: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted[0]!;
}

/** user/key.go CreateUserPublicKey's binding arm: upstream's web binder
 *  answers 422 `<Field>: <error>` for the Required fields (api.go:841-844) —
 *  the message tail is Go-binder-internal, the status is the compat surface. */
function requireKeyFields(form: CreateKeyOption): void {
  if (form.title === undefined || form.title === "") {
    throw new ApiError(422, "Title: Required");
  }
  if (form.key === undefined || form.key === "") {
    throw new ApiError(422, "Key: Required");
  }
}

/**
 * asymkey_model.AddGPGKey (gpg_key_add.go:66-160) reduced to the
 * no-verifiable-signature subset: parse (422 family), the signature arm
 * answers the upstream invalid-token-signature 422 (module header), per-key
 * global key_id check ("A key with the same id already exists" 422), the
 * activated-email gate (ErrGPGNoEmailFound 404), then the primary + subkey
 * row inserts. Returns the rendered-shape inputs for keys[0]'s 201.
 */
async function addGpgKey(
  d1: D1Database,
  owner: UserRow,
  form: CreateGpgKeyOption,
  token: string,
): Promise<typeof gpgKeys.$inferSelect> {
  const db = drizzle(d1);
  if (form.armored_public_key === undefined || form.armored_public_key === "") {
    throw new ApiError(422, "ArmoredKey: Required");
  }
  const entities = await parseArmoredGpgKey(form.armored_public_key);
  if (form.armored_signature !== undefined && form.armored_signature !== "") {
    throw invalidTokenSignatureError(token);
  }
  // parseGPGKey's email gate (gpg_key.go:163-189): every key needs ≥ 1
  // identity email on an ACTIVATED address of the owner.
  const activated = new Set(
    (
      await db
        .select({ lowerEmail: emailAddresses.lowerEmail })
        .from(emailAddresses)
        .where(and(eq(emailAddresses.userId, owner.id), eq(emailAddresses.isActivated, true)))
    ).map((row) => row.lowerEmail),
  );
  if (owner.email !== null && owner.email !== "") {
    activated.add(owner.email.toLowerCase()); // the synthesized primary is activated
  }
  const now = new Date();
  const inserts: (typeof gpgKeys.$inferInsert)[] = [];
  for (const entity of entities) {
    const keyIdTaken = await db.select({ id: gpgKeys.id }).from(gpgKeys).where(eq(gpgKeys.keyId, entity.keyId)).limit(1);
    if (keyIdTaken.length > 0) {
      // HandleAddGPGKeyError's ErrGPGKeyIDAlreadyUsed arm (gpg_key.go:315-316).
      throw new ApiError(422, "A key with the same id already exists");
    }
    if (!entity.identityEmails.some((email) => activated.has(email))) {
      // ErrGPGNoEmailFound's handler arm (gpg_key.go:319-320).
      throw new ApiError(
        404,
        "None of the emails attached to the GPG key could be found. It may still be added if you provide a valid signature for the token: " +
          token,
      );
    }
    inserts.push({
      ownerId: owner.id,
      keyId: entity.keyId,
      primaryKeyId: "",
      content: entity.content,
      verified: false,
      canSign: entity.canSign,
      canEncryptComms: entity.canEncrypt,
      canEncryptStorage: entity.canEncrypt,
      canCertify: entity.canSign,
      createdAt: entity.created,
      expiresAt: entity.expires === null ? null : new Date(entity.expires * 1000),
      addedAt: now,
    });
    for (const subkey of entity.subkeys) {
      // parseSubGPGKey: a subkey without its own lifetime inherits the
      // primary's expiry (gpg_key.go:81-84).
      inserts.push({
        ownerId: owner.id,
        keyId: subkey.keyId,
        primaryKeyId: entity.keyId,
        content: subkey.content,
        verified: false,
        canSign: subkey.canSign,
        canEncryptComms: subkey.canEncrypt,
        canEncryptStorage: subkey.canEncrypt,
        canCertify: subkey.canSign,
        createdAt: subkey.created,
        expiresAt: subkey.expires === null ? (entity.expires === null ? null : new Date(entity.expires * 1000)) : new Date(subkey.expires * 1000),
        addedAt: now,
      });
    }
  }
  for (const values of inserts) {
    await db.insert(gpgKeys).values(values);
  }
  const first = await db.select().from(gpgKeys).where(eq(gpgKeys.keyId, entities[0]!.keyId)).limit(1);
  return first[0]!;
}

// ---------------------------------------------------------------------------
// Admin seams (mirrors of admin-t2.ts — the shared helpers are that module's
// privates, and it is outside this wave's ownership)
// ---------------------------------------------------------------------------

/** admin-t2.ts requireSiteAdmin verbatim (api.go:343-347). */
function requireSiteAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (c.get("authUser")?.is_admin !== true) {
      throw new ApiError(403, "user should be the site admin");
    }
    await next();
  };
}

/** admin-t2.ts resolveTargetRow over the same seams (UserAssignmentAPI +
 *  the user_redirect 307); the visibility gate always passes (reqSiteAdmin
 *  guarantees an authenticated admin). */
async function resolveAdminTargetRow(c: Context<ApiEnv>, username: string): Promise<UserRow> {
  const row = await findUserByName(c.env.DB, username);
  if (row !== null) {
    return row;
  }
  const redirect = (
    await drizzle(c.env.DB)
      .select({ userId: userRedirects.redirectUserId })
      .from(userRedirects)
      .where(eq(userRedirects.lowerName, username.toLowerCase()))
      .limit(1)
  )[0];
  if (redirect !== undefined) {
    const target = (
      await drizzle(c.env.DB).select().from(users).where(eq(users.id, redirect.userId)).limit(1)
    )[0];
    if (target !== undefined) {
      const url = new URL(c.req.url);
      let location = url.pathname.replace(username, target.username);
      if (url.search !== "") {
        location += url.search;
      }
      throw new HTTPException(307, {
        res: new Response(null, { status: 307, headers: { Location: location } }),
      });
    }
  }
  throw new ApiError(404, `user redirect does not exist [name: ${username}]`);
}

/** Upstream's admin email search (user_model.SearchEmails, email_address.go:
 *  374-416) over the cf-gitea storage: real rows joined to their user plus
 *  the synthesized primary per user whose `users.email` has no row (module
 *  header). Keyword substring via the repo's instr() pattern (searchUsers
 *  precedent — D1 LIKE caps + escaping), default order `email ASC`
 *  (SearchEmailOrderByEmail), paginated in JS over the merged set. */
async function searchEmailEntries(
  d1: D1Database,
  keyword: string,
): Promise<Array<EmailEntry & { userId: number; username: string }>> {
  const db = drizzle(d1);
  const like = (column: ReturnType<typeof sql>) => sql`instr(${column}, ${keyword.toLowerCase()}) > 0`;
  const keywordCond = keyword !== "" ? like(sql`email_addresses.lower_email`) : undefined;
  const rows = await db
    .select({
      email: emailAddresses.email,
      isActivated: emailAddresses.isActivated,
      isPrimary: emailAddresses.isPrimary,
      userId: users.id,
      username: users.username,
    })
    .from(emailAddresses)
    .innerJoin(users, eq(users.id, emailAddresses.userId))
    .where(
      keywordCond === undefined
        ? eq(users.type, "user")
        : and(
            eq(users.type, "user"),
            or(
              keywordCond,
              like(sql`lower(${users.usernameLower})`),
              like(sql`lower(coalesce(${users.fullName}, ''))`),
            ),
          ),
    );
  const results = rows.map((row) => ({
    email: row.email,
    isActivated: row.isActivated,
    isPrimary: row.isPrimary,
    userId: row.userId,
    username: row.username,
  }));
  // The synthesized primary rows (users.email with no email_addresses row).
  const bareUsers = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(
      keywordCond === undefined
        ? and(eq(users.type, "user"), sql`${users.email} IS NOT NULL AND ${users.email} <> ''`)
        : and(
            eq(users.type, "user"),
            sql`${users.email} IS NOT NULL AND ${users.email} <> ''`,
            or(
              like(sql`lower(${users.email})`),
              like(sql`lower(${users.usernameLower})`),
              like(sql`lower(coalesce(${users.fullName}, ''))`),
            ),
          ),
    );
  for (const bare of bareUsers) {
    const emailLower = bare.email!.toLowerCase();
    const hasRow =
      keyword === ""
        ? (
            await db
              .select({ id: emailAddresses.id })
              .from(emailAddresses)
              .where(and(eq(emailAddresses.userId, bare.id), eq(emailAddresses.lowerEmail, emailLower)))
              .limit(1)
          ).length > 0
        : results.some((entry) => entry.userId === bare.id && entry.email.toLowerCase() === emailLower);
    if (!hasRow) {
      results.push({ email: bare.email!, isActivated: true, isPrimary: true, userId: bare.id, username: bare.username });
    }
  }
  results.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return results;
}

// ---------------------------------------------------------------------------

export function registerMiscT3Routes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  const requireAdmin = requireSiteAdmin();

  // GET /signing-key.gpg — always the signing.go:14-24 no-key 404: cf-gitea
  // has no signing-key configuration, so PublicSigningKey's format is blank
  // and upstream's own handler answers APIErrorNotFound("no signing key").
  app.openapi(signingKeyGpgRoute, () => {
    throw new ApiError(404, "no signing key");
  });

  // GET /signing-key.pub — the same helper's same arm (SigningKeySSH at
  // signing.go:100), hence the verbatim message.
  app.openapi(signingKeyPubRoute, () => {
    throw new ApiError(404, "no signing key");
  });

  // -- emails (user/email.go) ------------------------------------------------

  // GET /user/emails — GetEmailAddresses + convert.ToEmail; the synthesized
  // primary renders first (upstream's earliest-row order).
  app.openapi(userListEmailsRoute(requireAuth), async (c) => {
    const doer = await requireDoerRow(c);
    const entries = await emailEntriesOfUser(c.env.DB, doer);
    return c.json(entries.map((entry) => toApiEmail(entry)), 200);
  });

  // POST /user/emails — AddEmail: empty list 422, then AddEmailAddresses and
  // the 201 re-list (email.go:80-90 — the WHOLE list, like GET).
  app.openapi(userAddEmailRoute(requireAuth), async (c) => {
    const doer = await requireDoerRow(c);
    const form = (c.req.valid("json") ?? {});
    if (form.emails === undefined || form.emails.length === 0) {
      throw new ApiError(422, "Email list empty");
    }
    await addEmailAddresses(c.env.DB, doer, form.emails);
    const entries = await emailEntriesOfUser(c.env.DB, doer);
    return c.json(entries.map((entry) => toApiEmail(entry)), 201);
  });

  // DELETE /user/emails — DeleteEmail: empty list is the upstream no-op 204
  // (email.go:117-120); the batch is all-or-nothing.
  app.openapi(userDeleteEmailRoute(requireAuth), async (c) => {
    const doer = await requireDoerRow(c);
    const form = (c.req.valid("json") ?? {});
    if (form.emails !== undefined && form.emails.length > 0) {
      await deleteEmailAddresses(c.env.DB, doer, form.emails);
    }
    return c.body(null, 204);
  });

  // -- public keys (user/key.go) ----------------------------------------------

  // GET /user/keys — listPublicKeys over the doer; `fingerprint` switches to
  // the unrestricted by-fingerprint query (key.go:58-80 — "Querying not just
  // listing": no owner scoping on this arm, /user/keys included).
  app.openapi(userCurrentListKeysRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const url = new URL(c.req.url);
    const fingerprint = url.searchParams.get("fingerprint") ?? "";
    const listOptions = parseListOptions(url);
    const db = drizzle(c.env.DB);
    const where =
      fingerprint !== "" ? eq(publicKeys.fingerprint, fingerprint) : eq(publicKeys.ownerId, doer.id ?? 0);
    const total = Number((await db.select({ value: sql<number>`count(*)` }).from(publicKeys).where(where))[0]!.value);
    const rows = await db
      .select()
      .from(publicKeys)
      .where(where)
      .orderBy(asc(publicKeys.id))
      .limit(listOptions.limit)
      .offset((listOptions.page - 1) * listOptions.limit);
    setPaginationHeaders(c, total, listOptions);
    return c.json(
      await Promise.all(
        rows.map(async (row) => {
          const owner = await userRowById(c.env.DB, row.ownerId);
          return toApiPublicKey(c, row, owner, doer.is_admin === true || row.ownerId === doer.id);
        }),
      ),
      200,
    );
  });

  // POST /user/keys — CreatePublicKey → CreateUserPublicKey(doer).
  app.openapi(userCurrentPostKeyRoute(requireAuth), async (c) => {
    const doer = await requireDoerRow(c);
    const form = (c.req.valid("json") ?? {});
    requireKeyFields(form);
    const row = await addPublicKey(c.env.DB, doer, form);
    return c.json(toApiPublicKey(c, row, doer, true), 201);
  });

  // GET /user/keys/{id} — GetPublicKeyByID: NOT owner-scoped (key.go:190);
  // private information (owner/read_only/key_type) renders for the owner or
  // a site admin only (key.go:202-204).
  app.openapi(userCurrentGetKeyRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const row = (
      await drizzle(c.env.DB)
        .select()
        .from(publicKeys)
        .where(eq(publicKeys.id, pathParamId(c)))
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new ApiError(404, "not found");
    }
    const owner = await userRowById(c.env.DB, row.ownerId);
    return c.json(toApiPublicKey(c, row, owner, doer.is_admin === true || row.ownerId === doer.id), 200);
  });

  // DELETE /user/keys/{id} — DeletePublicKey: miss 404
  // (PublicKeyIsExternallyManaged's ErrNotExist arm), non-owner non-admin
  // 403 "You do not have access to this key" (DeletePublicKey's
  // ErrKeyAccessDenied arm); the externally-managed 403 is unreachable (no
  // login sources — login_source_id is always 0).
  app.openapi(userCurrentDeleteKeyRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const row = (
      await drizzle(c.env.DB)
        .select()
        .from(publicKeys)
        .where(eq(publicKeys.id, pathParamId(c)))
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new ApiError(404, "not found");
    }
    if (doer.is_admin !== true && row.ownerId !== doer.id) {
      throw new ApiError(403, "You do not have access to this key");
    }
    await drizzle(c.env.DB).delete(publicKeys).where(eq(publicKeys.id, row.id));
    return c.body(null, 204);
  });

  // -- GPG keys (user/gpg_key.go) ----------------------------------------------

  // GET /user/gpg_key_token — VerificationToken(doer, 1) as text/plain
  // (gpg_key.go:181-182).
  app.openapi(getVerificationTokenRoute(requireAuth), async (c) => {
    const doer = await requireDoerRow(c);
    return c.text(await verificationToken(doer, 1), 200);
  });

  // GET /user/gpg_keys — listGPGKeys over the doer (primary rows only,
  // LoadSubKeys attached).
  app.openapi(userCurrentListGpgKeysRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const listOptions = parseListOptions(new URL(c.req.url));
    const db = drizzle(c.env.DB);
    const where = and(eq(gpgKeys.ownerId, doer.id ?? 0), eq(gpgKeys.primaryKeyId, ""));
    const total = Number((await db.select({ value: sql<number>`count(*)` }).from(gpgKeys).where(where))[0]!.value);
    const rows = await db
      .select()
      .from(gpgKeys)
      .where(where)
      .orderBy(asc(gpgKeys.id))
      .limit(listOptions.limit)
      .offset((listOptions.page - 1) * listOptions.limit);
    const subkeys = await loadSubkeys(c.env.DB, rows.map((row) => row.keyId));
    setPaginationHeaders(c, total, listOptions);
    return c.json(rows.map((row) => toApiGpgKey(row, subkeys.get(row.keyId) ?? [])), 200);
  });

  // POST /user/gpg_keys — CreateGPGKey → CreateUserGPGKey(doer).
  app.openapi(userCurrentPostGpgKeyRoute(requireAuth), async (c) => {
    const doer = await requireDoerRow(c);
    const form = (c.req.valid("json") ?? {});
    const token = await verificationToken(doer, 1);
    const row = await addGpgKey(c.env.DB, doer, form, token);
    const subkeys = await loadSubkeys(c.env.DB, [row.keyId]);
    return c.json(toApiGpgKey(row, subkeys.get(row.keyId) ?? []), 201);
  });

  // GET /user/gpg_keys/{id} — GetGPGKeyForUserByID: OWNER-SCOPED
  // (gpg_key.go:126 — unlike the public-key GET).
  app.openapi(userCurrentGetGpgKeyRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const row = (
      await drizzle(c.env.DB)
        .select()
        .from(gpgKeys)
        .where(and(eq(gpgKeys.id, pathParamId(c)), eq(gpgKeys.ownerId, doer.id ?? 0)))
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new ApiError(404, "not found");
    }
    const subkeys = await loadSubkeys(c.env.DB, [row.keyId]);
    return c.json(toApiGpgKey(row, subkeys.get(row.keyId) ?? []), 200);
  });

  // DELETE /user/gpg_keys/{id} — upstream answers 204 for ANY id the doer
  // does not own: models.DeleteGPGKey returns nil on ErrGPGKeyNotExist
  // (gpg_key.go:227-233; the module header documents the stub correction).
  app.openapi(userCurrentDeleteGpgKeyRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const row = (
      await drizzle(c.env.DB)
        .select()
        .from(gpgKeys)
        .where(and(eq(gpgKeys.id, pathParamId(c)), eq(gpgKeys.ownerId, doer.id ?? 0)))
        .limit(1)
    )[0];
    if (row !== undefined) {
      await drizzle(c.env.DB)
        .delete(gpgKeys)
        .where(or(eq(gpgKeys.keyId, row.keyId), eq(gpgKeys.primaryKeyId, row.keyId)));
    }
    return c.body(null, 204);
  });

  // -- admin (admin/email.go + admin/user.go key arms) -------------------------

  // GET /admin/emails — GetAllEmails with NO keyword (the handler reads
  // ctx.PathParam("email"), which never exists on this route).
  app.openapi(adminGetAllEmailsRoute(requireAuth, requireAdmin), async (c) => {
    const listOptions = parseListOptions(new URL(c.req.url));
    const entries = await searchEmailEntries(c.env.DB, "");
    const start = (listOptions.page - 1) * listOptions.limit;
    const page = entries.slice(start, start + listOptions.limit);
    setPaginationHeaders(c, entries.length, listOptions);
    return c.json(page.map((entry) => toApiEmail(entry, { id: entry.userId, username: entry.username })), 200);
  });

  // GET /admin/emails/search — SearchEmail: q keyword, same listing.
  app.openapi(adminSearchEmailsRoute(requireAuth, requireAdmin), async (c) => {
    const listOptions = parseListOptions(new URL(c.req.url));
    const q = new URL(c.req.url).searchParams.get("q")?.trim() ?? "";
    const entries = await searchEmailEntries(c.env.DB, q);
    const start = (listOptions.page - 1) * listOptions.limit;
    const page = entries.slice(start, start + listOptions.limit);
    setPaginationHeaders(c, entries.length, listOptions);
    return c.json(page.map((entry) => toApiEmail(entry, { id: entry.userId, username: entry.username })), 200);
  });

  // POST /admin/users/{username}/keys — adminCreatePublicKey: the SAME
  // CreateUserPublicKey helper against the ContextUser (admin/user.go:348).
  // The unknown-username miss 404 is runtime-only-undeclared (module header).
  app.openapi(adminCreatePublicKeyRoute(requireAuth, requireAdmin), async (c) => {
    const { username } = c.req.valid("param");
    const target = await resolveAdminTargetRow(c, username);
    const form = (c.req.valid("json") ?? {});
    requireKeyFields(form);
    const row = await addPublicKey(c.env.DB, target, form);
    return c.json(toApiPublicKey(c, row, target, true), 201);
  });

  // DELETE /admin/users/{username}/keys/{id} — adminDeleteUserPublicKey over
  // asymkey_service.DeletePublicKey(ContextUser, id): the admin caller
  // always passes the access check; miss → 404.
  app.openapi(adminDeleteUserPublicKeyRoute(requireAuth, requireAdmin), async (c) => {
    const { username } = c.req.valid("param");
    await resolveAdminTargetRow(c, username);
    const row = (
      await drizzle(c.env.DB)
        .select()
        .from(publicKeys)
        .where(eq(publicKeys.id, pathParamId(c)))
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new ApiError(404, "not found");
    }
    await drizzle(c.env.DB).delete(publicKeys).where(eq(publicKeys.id, row.id));
    return c.body(null, 204);
  });
}

// ---------------------------------------------------------------------------
// Handler-local helpers
// ---------------------------------------------------------------------------

/** ctx.PathParamInt64: non-numeric wire values degrade to 0 → the miss. */
function pathParamId(c: Context<ApiEnv>): number {
  const raw = c.req.param("id") ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && /^\d+$/.test(raw) ? parsed : 0;
}

/** The authUser's D1 row — the storage-backed operations need the row's
 *  createdAt/email (VerificationToken, the synthesized primary), which the
 *  contract User shape only partially mirrors. */
async function requireDoerRow(c: Context<ApiEnv>): Promise<UserRow> {
  const authUser = c.get("authUser");
  if (authUser === undefined || authUser.id === undefined) {
    throw new ApiError(401, "token is required");
  }
  const row = await userRowById(c.env.DB, authUser.id);
  if (row === null) {
    // The token resolved (requireAuth) but the row is gone (deleted user
    // with an unrevoked token): the upstream credential re-check answers
    // the standard 401 body.
    throw new ApiError(401, "invalid username, password or token");
  }
  return row;
}

async function userRowById(d1: D1Database, id: number): Promise<UserRow | null> {
  return (await drizzle(d1).select().from(users).where(eq(users.id, id)).limit(1))[0] ?? null;
}
