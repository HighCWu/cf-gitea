/**
 * The shared password-authentication path — SPEC-0002 §6.3-4/§6.2 matrix.
 * Upstream at pin v29.0.0-dev-208-gfc493688:
 * - services/auth/signin.go:27-102                 UserSignIn lookup arms
 * - services/auth/source/db/authenticate.go:46-87  the Authenticate ladder
 * - models/user/user.go:407-414                    SetPassword (the rehash write)
 * - models/user/user.go:920-936                    GetVerifyUser shape (reset)
 *
 * Consumers: the web login (ui/session.ts), the API Basic password arm
 * (auth/middleware.ts), the git-HTTPS arm (git-http/acl.ts). Every failure
 * kind except `prohibited` renders upstream's GENERIC credential failure on
 * its surface ("Username or password is incorrect." web flash / the 401
 * "invalid username, password or token" API body); `unsupported-hash`
 * additionally logs the controlled cause (SPEC §6.3-3, ADR-0008 rule 4).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { emailAddresses, users } from "../db/schema";
import { rowToUser } from "./token-service";
import type { AuthUser } from "./auth-context";
import {
  isPasswordSet,
  needsRehash,
  newPasswordRecord,
  verifyPassword,
  PasswordHashUnsupportedError,
} from "./password";

export type UserRow = typeof users.$inferSelect;

/** The failure taxonomy (SPEC-0002 §6.2 — the wire class per kind). */
export type PasswordSignInFailure =
  /** ErrUserNotExist / ErrEmailAddressNotExist (signin.go:48,63,146). */
  | { kind: "user-not-exist" }
  /** ErrUserPasswordNotSet (authenticate.go:51-53). */
  | { kind: "password-not-set" }
  /** ErrUserPasswordInvalid (authenticate.go:53-55). */
  | { kind: "password-invalid" }
  /** ErrUserProhibitLogin (authenticate.go:71-84 + signin.go:96-98). */
  | { kind: "prohibited" }
  /** The controlled parse failure — verify NEVER silently mismatches. */
  | { kind: "unsupported-hash"; error: PasswordHashUnsupportedError };

export type PasswordSignInResult =
  | { ok: true; user: UserRow; rehashed: boolean }
  | { ok: false; failure: PasswordSignInFailure };

/**
 * The deploy-config knobs the rehash-on-login arm consumes (census B-87's
 * consumption half): `configuredHashSpec` is the caller's env-resolved
 * CONFIGURED specification — `configuredPasswordHashAlgo(env).specification`
 * (api/config.ts, the dealiased security.go:175 value upstream boots with;
 * this module has no env, so callers with one bridge it — the house
 * env→reader→arm pattern). Omitted, the landed pbkdf2$50000$50 default
 * stands (password.ts CONFIGURED_HASH_SPEC): needsRehash compares against
 * it and the rehash WRITE stores under it.
 */
export interface PasswordSignInOptions {
  configuredHashSpec?: string;
}

/**
 * `UserSignIn(name|email, password)` against the DB source — the lookup
 * arms (signin.go:27-52) folded with the Authenticate ladder
 * (authenticate.go:46-87). `login` containing "@" goes through the
 * email_addresses table (lower_email match, activated rows only,
 * signin.go:30-44); anything else is the case-folded individual-user name
 * arm (GetIndividualUserByName — org rows read as not-exist).
 */
export async function userSignInPassword(
  d1: D1Database,
  login: string,
  password: string,
  options?: PasswordSignInOptions,
): Promise<PasswordSignInResult> {
  const db = drizzle(d1);
  let user: UserRow | null;

  if (login.includes("@")) {
    const address = await db
      .select()
      .from(emailAddresses)
      .where(eq(emailAddresses.lowerEmail, login.trim().toLowerCase()))
      .get();
    if (address === undefined || !address.isActivated) {
      return { ok: false, failure: { kind: "user-not-exist" } };
    }
    user =
      (await db
        .select()
        .from(users)
        .where(and(eq(users.id, address.userId), eq(users.type, "user")))
        .get()) ?? null;
    if (user === null) return { ok: false, failure: { kind: "user-not-exist" } };
  } else {
    const trimmed = login.trim();
    if (trimmed.length === 0) return { ok: false, failure: { kind: "user-not-exist" } };
    user =
      (await db
        .select()
        .from(users)
        .where(and(eq(users.usernameLower, trimmed.toLowerCase()), eq(users.type, "user")))
        .get()) ?? null;
    if (user === null) return { ok: false, failure: { kind: "user-not-exist" } };
  }

  // authenticate.go:51-53 — an empty row never reaches a hash call.
  if (!isPasswordSet(user.passwd)) {
    return { ok: false, failure: { kind: "password-not-set" } };
  }

  // authenticate.go:53-55 — ValidatePassword. The controlled unsupported-
  // algo error escapes as a failure KIND (never a silent false, never an
  // unlogged throw); the caller renders the generic wire failure and logs
  // error.message for the server log (SPEC §6.3-3).
  let valid: boolean;
  try {
    valid = await verifyPassword(password, user.passwd, user.salt, user.passwdHashAlgo);
  } catch (error) {
    if (error instanceof PasswordHashUnsupportedError) {
      return { ok: false, failure: { kind: "unsupported-hash", error } };
    }
    throw error;
  }
  if (!valid) return { ok: false, failure: { kind: "password-invalid" } };

  // authenticate.go:55-67 — the rehash-on-login ladder: algorithm moved OR
  // salt length is not the current 32 — new salt + the CONFIGURED algorithm
  // (options.configuredHashSpec, the env-driven arm — see
  // PasswordSignInOptions), updating exactly (passwd, passwd_hash_algo,
  // salt).
  //
  // When the CONFIGURED spec is verify-only/unexecutable in this runtime
  // (argon2/bcrypt — the wasm verifier verifies but cannot WRITE; scrypt/
  // above-cap — parse-refused outright), the rehash WRITE refuses through
  // the controlled PasswordHashUnsupportedError (password.ts's landed arms
  // — never a silent fallback to the default algorithm). The DERIVED posture
  // for this arm: SKIP the migration and let the verified login proceed
  // (logged for the server log). Upstream propagates SetPassword errors here
  // (authenticate.go:56-59 `return nil, err`) but can never reach that
  // mismatch — an unparseable spec dies in the boot log.Fatal
  // (security.go:176-178) and Go writes argon2 fine — while Workers cannot;
  // failing a SUCCESSFULLY-verified login over an operator-configured
  // write-impossible migration target would diverge from upstream's
  // success-by-default more than skipping the migration does. The row stays
  // on its stored (verifiable) algorithm; rehashed=false.
  let rehashed = false;
  if (needsRehash(user.passwdHashAlgo, user.salt, options?.configuredHashSpec)) {
    try {
      const record = await newPasswordRecord(password, options?.configuredHashSpec);
      await db
        .update(users)
        .set({ passwd: record.passwd, salt: record.salt, passwdHashAlgo: record.passwdHashAlgo })
        .where(eq(users.id, user.id));
      user = { ...user, passwd: record.passwd, salt: record.salt, passwdHashAlgo: record.passwdHashAlgo };
      rehashed = true;
    } catch (error) {
      if (error instanceof PasswordHashUnsupportedError) {
        console.error(`password-auth: rehash skipped (configured spec not writable here): ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  // authenticate.go:71-84 + signin.go:96-98 — prohibit (double gate) and
  // the non-individual refusal.
  if (user.status !== "active") return { ok: false, failure: { kind: "prohibited" } };

  return { ok: true, user, rehashed };
}

/** The row as an AuthUser (the Basic arms' doer — rowToUser is the
 *  canonical constructor, token-service.ts). */
export function authUserFromRow(row: UserRow): AuthUser {
  return rowToUser(row);
}
