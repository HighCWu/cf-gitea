/**
 * The identity ladder — the external identity's resolution, linking, and
 * the dance-state machinery (specs/external-auth-sources.md §5.3/§5.5, the
 * port of `routers/web/auth/oauth.go:40-544`'s resolution core and the
 * W1-recorded `oauth2LoginState` encoder + 8 KiB bound).
 *
 * ## The ladder as-built (§5.5, upstream's resolution order adapted)
 *
 * Upstream checks TWO join surfaces — the `users` columns
 * (`GetIndividualUserByLoginSource`, oauth.go:498-503 over
 * user.go:111-113's LoginType/LoginSource/LoginName) first, then the
 * `external_login_user` join (:504-521, with the stale-link cleanup
 * :520-541). Our v1 drops the users-column path STRUCTURALLY (SPEC §4.3:
 * the dual path exists for the password-source types that stamp those
 * columns; OAuth2-only resolves through the join), so the ladder is the
 * join straight to `external_login_user` — the W1-recorded open item:
 *
 *   1. `resolveByExternalLogin`: the (sourceId, externalId) point read; a
 *      hit whose user row is an active individual ⇒ that user signs in.
 *      A STALE link — user row gone (structurally impossible here: the FK
 *      cascade removes the link with the user; the check stays as the belt
 *      for the direct-delete paths) or a non-individual row (org) — is
 *      DELETED (`removeExternalLoginByExternalId`,
 *      external_login_user.go:133-137, the oauth.go:520-541 port) so the
 *      next sign-in relinks.
 *   2. Miss ⇒ the caller branches: a signed-in doer links the identity to
 *      the CURRENT account and lands on settings/security
 *      (oauth.go:133-141); an anonymous visitor takes the link-account
 *      arms (§5.5.3).
 *   3. NO email-matching, ever (§7.4): the lookup keys are
 *      (sourceId, externalId) only; the email claim is profile data.
 *
 * ## The state dance carriers (the §4.4 column + the anonymous cookie)
 *
 * The dance state parks on the session row (`sessions.oauth2_login_state`,
 * §4.4) — but a session row REQUIRES a user (sessions.user_id NOT NULL,
 * migration 0013), and the primary dance starts from the LOGGED-OUT
 * /login buttons. Upstream's carrier is its own anonymous server-side
 * session (gorilla key/data rows with no user binding) — impossible on
 * this schema. The as-built answer (recorded in the SPEC's W2 marks):
 * the SAME encoded state rides TWO carriers —
 *
 *   - a valid session ⇒ the session row column (server-side, tamper-proof;
 *     the SPEC §4.4 letter);
 *   - anonymous ⇒ a short-lived `gitea_oauth2_state` cookie carrying the
 *     same encoded state (double-submit: the callback requires the query
 *     `state` to equal the cookie's `expectedState`; planting a known
 *     state would require setting OUR cookie, which only OUR authorize leg
 *     can do — and it mints a fresh random state). The identity NEVER
 *     rides the cookie — the post-exchange identity is either consumed
 *     immediately (join hit / signed-in link) or re-verified by the IdP
 *     after the link arms mint a session (the re-dance below).
 *
 * ## The link-account arms' re-dance (the §5.5.3 arms on this substrate)
 *
 * Upstream parks the goth user in its session and the POST arms link it
 * directly. With no anonymous server-side session there is nowhere
 * tamper-proof to park the identity client-side, and linking a
 * bearer-supplied identity would be a link-forgery primitive. So each arm
 * verifies its credential (the sign-in arm: the PAT posture; the signup
 * arm: the shared registration ladder), MINTS the session (the fixation
 * posture — a fresh row), and answers a redirect THROUGH THE DANCE AGAIN:
 * `303 /user/oauth2/{source}?...` — the IdP re-asserts the identity against
 * the now-authenticated session (its own SSO bounce answers in a hop — the
 * same fast-path shape upstream itself documents, oauth.go:48-58) and the
 * callback completes the link with the state parked on the session row.
 * The identity is therefore ALWAYS IdP-fresh at link time.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { initWindowOpen } from "../user-accounts";
import { ensureExternalLogin, getExternalLogin, removeExternalLoginByExternalId, type ExternalLoginRow, type LoginSourceRow } from "./store";

// ---------------------------------------------------------------------------
// The oauth2LoginState encoder (the W1-recorded W2 open item) + the 8 KiB
// bound (SPEC §4.4/§7.6 — upstream's MaxTokenLength cookie-trap answer,
// modules/setting/oauth2.go:110)
// ---------------------------------------------------------------------------

/** The dance state — §4.4's field set in the schema comment's order. The
 *  identity fields (`externalId`…`avatarUrl`) exist for the SPEC §5.5.3
 *  park; W2's flow never writes them (the identity is consumed at the
 *  callback or re-verified by the re-dance) — they stay defined so the
 *  sync/auto-reg arms land as code, not schema. `continue` is W2's
 *  re-dance discriminator (the module header). */
export interface OAuth2LoginState {
  sourceId: number;
  provider: string;
  expectedState: string;
  nonce?: string;
  externalId?: string;
  email?: string;
  name?: string;
  nickName?: string;
  avatarUrl?: string;
  returnTo?: string;
  /** W2: the link-arm continuation — the re-dance's callback completes the
   *  link against the refreshed identity and lands on the parked returnTo
   *  (not the signed-in arm's settings/security). */
  continue?: "signin-link" | "signup";
}

/** The hard cap at write (§7.6). Upstream's trap was a 32767-byte cookie;
 *  ours is the session TEXT column — the bound is the recorded answer. */
export const OAUTH2_LOGIN_STATE_MAX_BYTES = 8 * 1024;

/** The fixed wire-key order (the cfg codec's determinism discipline). */
const STATE_KEY_ORDER: readonly (keyof OAuth2LoginState)[] = [
  "sourceId",
  "provider",
  "expectedState",
  "nonce",
  "externalId",
  "email",
  "name",
  "nickName",
  "avatarUrl",
  "returnTo",
  "continue",
];

/** The fields truncation may shorten (§7.6: "the identity fields truncate
 *  and the flow still completes (externalId/email/name never truncate)").
 *  externalId/email/name are NEVER truncated — an identity that cannot be
 *  re-derived must fail loudly, not silently. */
const TRUNCATABLE: readonly (keyof Pick<OAuth2LoginState, "nickName" | "avatarUrl" | "returnTo">)[] = [
  "nickName",
  "avatarUrl",
  "returnTo",
];

/** Encode for a carrier write: fixed key order, the §7.6 bound enforced by
 *  truncating the descriptive fields (never externalId/email/name) until
 *  the whole form fits; a state whose MANDATORY core cannot fit (unreachable
 *  — the core is id+key+uuid sized) throws. */
export function encodeOAuth2LoginState(state: OAuth2LoginState): string {
  const encode = (partial: Partial<OAuth2LoginState>): string => {
    const ordered: Record<string, unknown> = {};
    for (const key of STATE_KEY_ORDER) {
      if (partial[key] !== undefined) ordered[key] = partial[key];
    }
    return JSON.stringify(ordered);
  };

  let encoded = encode(state);
  if (encoded.length <= OAUTH2_LOGIN_STATE_MAX_BYTES) return encoded;

  // Overflow: truncate the truncatable fields until the whole form fits.
  const partial: Partial<OAuth2LoginState> = { ...state };
  for (const key of TRUNCATABLE) {
    const value = partial[key];
    if (typeof value !== "string") continue;
    // Halve until it fits; a field that cannot shrink below one character
    // without the form still overflowing is dropped ENTIRELY (the loop's
    // fixed point — slice(0, 1) of a 1-char string is itself — would spin
    // forever otherwise).
    let candidate = value;
    while (candidate.length > 1) {
      candidate = candidate.slice(0, Math.max(1, Math.floor(candidate.length / 2)));
      partial[key] = candidate;
      encoded = encode(partial);
      if (encoded.length <= OAUTH2_LOGIN_STATE_MAX_BYTES) return encoded;
    }
    delete partial[key];
    encoded = encode(partial);
    if (encoded.length <= OAUTH2_LOGIN_STATE_MAX_BYTES) return encoded;
  }
  // Only the never-truncate fields remain and the form still overflows —
  // fail loudly rather than write a state the callback cannot trust.
  throw new Error(`oauth2 login state exceeds the ${String(OAUTH2_LOGIN_STATE_MAX_BYTES)}-byte bound`);
}

/** Decode a carrier value: `null` for anything malformed (a truncated or
 *  foreign payload is NO state, never a partial dance — the caller answers
 *  the failure arm). */
export function decodeOAuth2LoginState(raw: string | null | undefined): OAuth2LoginState | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  const sourceId = record.sourceId;
  const provider = record.provider;
  const expectedState = record.expectedState;
  if (
    typeof sourceId !== "number" ||
    !Number.isInteger(sourceId) ||
    sourceId <= 0 ||
    typeof provider !== "string" ||
    provider.length === 0 ||
    typeof expectedState !== "string" ||
    expectedState.length === 0
  ) {
    return null;
  }
  const state: OAuth2LoginState = { sourceId, provider, expectedState };
  if (typeof record.nonce === "string") state.nonce = record.nonce;
  for (const key of ["externalId", "email", "name", "nickName", "avatarUrl", "returnTo"] as const) {
    const value = record[key];
    if (typeof value === "string") state[key] = value;
  }
  if (record.continue === "signin-link" || record.continue === "signup") state.continue = record.continue;
  return state;
}

// ---------------------------------------------------------------------------
// The dance cookie (the anonymous carrier — module header)
// ---------------------------------------------------------------------------

export const OAUTH2_DANCE_COOKIE_NAME = "gitea_oauth2_state";

/** Same flag set as the session cookie (session.ts §2.3) + a 10-minute
 *  Max-Age so a planted cookie self-expires (a dance completes in
 *  seconds; the bound only caps a stale carrier's life). */
export function oauth2DanceSetCookie(value: string): string {
  return `${OAUTH2_DANCE_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function oauth2DanceClearCookie(): string {
  return `${OAUTH2_DANCE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** First `gitea_oauth2_state` cookie value, URI-decoded; `null` when
 *  absent/empty/undecodable. */
export function oauth2DanceCookieValue(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    if (pair.slice(0, at).trim() === OAUTH2_DANCE_COOKIE_NAME) {
      const raw = pair.slice(at + 1).trim();
      if (raw === "") return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Constant-time string compare (the house convention, session.ts's
 *  digest twin) — the state compare is the dance's CSRF gate. */
export function timingSafeStateEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The ladder (§5.5)
// ---------------------------------------------------------------------------

/** The bounded profile slice of a verified external identity — exactly the
 *  external_login_user profile columns (SPEC §4.3); OIDC's standard claims
 *  never carry location/description, so those two stay absent. */
export interface ExternalIdentityProfile {
  externalId: string;
  email: string | null;
  name: string | null;
  nickName: string | null;
  avatarUrl: string | null;
  firstName: string | null;
  lastName: string | null;
}

export type ExternalResolution =
  | { outcome: "linked"; user: { id: number; username: string; status: string; type: string }; link: ExternalLoginRow }
  | { outcome: "unlinked" };

/**
 * Ladder step 1 — the join straight to `external_login_user` (module
 * header; the SPEC §4.3 decision that drops upstream's users-column
 * path). A stale link (user row gone — structurally impossible behind the
 * FK cascade, kept as the belt — or a non-individual row) is REMOVED
 * (`removeExternalLoginByExternalId`, the oauth.go:520-541 port) and the
 * ladder answers `unlinked` so the caller's arms take over.
 */
export async function resolveByExternalLogin(
  d1: D1Database,
  source: LoginSourceRow,
  profile: ExternalIdentityProfile,
): Promise<ExternalResolution> {
  const link = await getExternalLogin(d1, source.id, profile.externalId);
  if (link === null) return { outcome: "unlinked" };

  const user = await drizzle(d1)
    .select({ id: users.id, username: users.username, status: users.status, type: users.type })
    .from(users)
    .where(eq(users.id, link.userId))
    .get();
  if (user === undefined || user.type !== "user") {
    // The stale-link cleanup (oauth.go:520-541): "Remove it so the next
    // sign-in can relink the external account to the correct user."
    await removeExternalLoginByExternalId(d1, source.id, profile.externalId);
    return { outcome: "unlinked" };
  }
  return { outcome: "linked", user, link };
}

/**
 * The link upsert (`EnsureLinkExternalToUser`, external_login_user.go:161+
 * via the W1 store op): insert or full profile refresh. The token columns
 * stay ABSENT — v1 writes no provider secrets (SPEC §7.8).
 */
export async function linkIdentityToUser(
  d1: D1Database,
  source: LoginSourceRow,
  userId: number,
  profile: ExternalIdentityProfile,
): Promise<ExternalLoginRow> {
  return ensureExternalLogin(d1, {
    externalId: profile.externalId,
    loginSourceId: source.id,
    userId,
    provider: providerKeyOf(source),
    email: profile.email,
    name: profile.name,
    nickName: profile.nickName,
    avatarUrl: profile.avatarUrl,
    firstName: profile.firstName,
    lastName: profile.lastName,
  });
}

/** The link row's `provider` — the goth registry key from the source's cfg
 *  (the column survives source renames, external_login_user.go:57). A
 *  dead-cfg source links under the empty key rather than guessing. */
function providerKeyOf(source: LoginSourceRow): string {
  try {
    const parsed = JSON.parse(source.cfg) as { provider?: unknown };
    return typeof parsed.provider === "string" ? parsed.provider : "";
  } catch {
    return "";
  }
}

/**
 * The admin-init-window guard (SPEC §5.5.3 — the ONE non-upstream rule):
 * while the zero-user bootstrap window is open, BOTH link-account arms
 * refuse and the flow redirects to /user/login — the first human must come
 * from the one-shot /install. The W5 arms call this before their credential
 * verification; a direct resolution can never hit the window (a link row
 * FKs to a user, so its existence already proves a human row — the window
 * is closed). Upstream has no analog (its install wizard completes before
 * sources can exist); recorded as an intentional strengthening.
 */
export async function externalSignupBlockedByInitWindow(d1: D1Database): Promise<boolean> {
  return initWindowOpen(d1);
}

// ---------------------------------------------------------------------------
// The link-arm helpers (§5.5.3)
// ---------------------------------------------------------------------------

/** Upstream `NormalizeUserName` essentials (models/user/user.go) — the
 *  pre-fill sanitizer: keep the username-safe characters, replace the
 *  rest with `_`, lower-case-free (display preserved), cap at 40. The
 *  POST arms re-validate through the shared ladder; this only shapes the
 *  input. */
export function sanitizeSuggestedUsername(raw: string): string {
  const replaced = raw.replace(/[^\w\-.]/g, "_").replace(/^[-._]+/, "").slice(0, 40);
  return replaced;
}

/**
 * `extractUserNameFromOAuth2` (auth.go:434) under the SPEC §5.5.3's merged
 * order: validated `preferred_username` → sanitized email local-part →
 * `externalId` (upstream's default OAuth2UsernameUserid arm). Pure — the
 * caller feeds the verified claims slice.
 */
export function suggestedUsername(profile: ExternalIdentityProfile, preferredUsername?: string | null): string {
  if (preferredUsername !== null && preferredUsername !== undefined && preferredUsername !== "") {
    const sanitized = sanitizeSuggestedUsername(preferredUsername);
    if (sanitized !== "") return sanitized;
  }
  if (profile.email !== null) {
    const local = profile.email.split("@")[0] ?? "";
    const sanitized = sanitizeSuggestedUsername(local);
    if (sanitized !== "") return sanitized;
  }
  return sanitizeSuggestedUsername(profile.externalId);
}
