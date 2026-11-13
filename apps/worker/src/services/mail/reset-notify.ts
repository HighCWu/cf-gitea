/**
 * The password-reset mail (specs/email-outbound.md §2.5, census B-84) — the
 * port of upstream `SendResetPasswordMail`
 * (gitea/services/mailer/mail_user.go:62-72) over the outbox service, plus
 * the forgot-REQUEST arm's account lookup and resend throttle. The trigger
 * surface is `POST /user/forgot_password` (routers/web/auth/password.go:53-106
 * — the request half of module 3's reset row; the reset-COMPLETE half lives
 * in ui/session.ts over auth/reset-code.ts).
 *
 * Upstream posture, carried verbatim: the mail fires with NO IsMailable gate
 * (unlike SendRegisterNotifyMail, mail_user.go:62 checks ONLY
 * `MailService == nil`) — the recipient is `u.EmailTo()`, the account's
 * PRIMARY address, even when the lookup matched a secondary one. Every
 * allowed POST sends a FRESH time-limit code (no dedupe — the draft's
 * dedupeKey is null; the 180 s resend throttle below is the rate limiter).
 * The fire-and-forget send (SendAsync) is the issue-events seam posture: the
 * route awaits the outbox INSERT and catches — a mailer outage must never
 * fail the "sent" page.
 *
 * The resend throttle: upstream arms a per-user cache key
 * (`ctx.Cache.Put("MailResendLimit_"+lowerName, …, 180)`, password.go:87-101)
 * that suppresses resends for 180 SECONDS. Workers expose no cache
 * abstraction in this service's Env, so the TTL rides the D1 outbox ledger
 * itself: a reset mail row carrying the upstream Info string for this UID
 * within the last 180 s arms the limit (the recorded PLATFORM adaptation —
 * upstream's cache arms even when the async send later drops; ours arms only
 * when the durable row exists, the direction that can only UNDER-send).
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { emailAddresses, emailOutbox, externalLoginUsers, loginSources, users } from "../../db/schema";
import { parseMailFrom } from "./message";
import { enqueueMailOutbox, type EnqueueOutcome, type MailOutboxEnv } from "./outbox";
import { appUrlWithSlash, GITEA_APP_NAME } from "./register-notify";
import { resetPasswordMailSubject, renderResetPasswordMail } from "./templates";

/** service.go:147 — `RESET_PASSWD_CODE_LIVE_MINUTES` MustInt(180), rendered
 *  through MinutesToFriendly (modules/timeutil/since.go:83): 180 min =
 *  10800 s → the 3-hour bucket exactly → `tool.hours` = "3 hours". Both the
 *  forgot page's sent prompt and the mail body interpolate this string; the
 *  config knob has no cf-gitea var, the default is the constant. */
export const RESET_PWD_CODE_LIVES_FRIENDLY = "3 hours";

/** password.go:99 — the resend-limit TTL in seconds (`Cache.Put(…, 180)`). */
export const MAIL_RESEND_LIMIT_SECONDS = 180;

/**
 * The forgot arm's mailer-present check — upstream `setting.MailService ==
 * nil` (password.go:39/:56) over the MAIL_ENABLED master gate's strict
 * polarity (SPEC §5.1: only the exact "true" arms). The generated Env types
 * the var as the example's literal, so the widened shape is the parameter
 * (the demoModeEnabled cast pattern, without the cast).
 */
export function mailerConfigured(env: { MAIL_ENABLED?: string }): boolean {
  return env.MAIL_ENABLED === "true";
}

/** Upstream `auth.OAuth2` (models/auth/source.go) — the only login-source
 *  type v1 carries (the login_source.type schema note). */
const OAUTH2_SOURCE_TYPE = 6;

/** The user slice the forgot arm reads (the `users` row's used shape). */
export interface ResetMailUser {
  id: number;
  username: string;
  usernameLower: string;
  email: string | null;
  displayName: string | null;
  fullName: string | null;
  /** `users.type` — "user" (individual) | "org"; orgs fold into the
   *  not-exist arm upstream (password.go:66-68). */
  type: string;
}

/**
 * `GetUserByEmail` (models/user/user.go:1372-1399) — the case-folded lookup:
 * an ACTIVATED `email_addresses` row first, then the primary address.
 * Upstream keeps the primary in the same table (the is_primary row
 * materialized at signup); cf-gitea keeps it on `users.email` with the read
 * side synthesizing the row back (the email_addresses schema note, the
 * routes/misc-t3.ts precedent). The NoReplyAddress arm (user.go:1392-1397)
 * has no cf-gitea surface — the noreply address scheme is not configured
 * here, the recorded divergence. Returns the row for ORGS too — the caller
 * folds non-individuals into the not-exist arm (password.go:66-68).
 */
export async function lookupUserByEmail(
  d1: D1Database,
  rawEmail: string,
): Promise<ResetMailUser | null> {
  if (rawEmail === "") return null;
  const lower = rawEmail.toLowerCase();
  const db = drizzle(d1);
  const secondary = await db
    .select({
      id: users.id,
      username: users.username,
      usernameLower: users.usernameLower,
      email: users.email,
      displayName: users.displayName,
      fullName: users.fullName,
      type: users.type,
    })
    .from(emailAddresses)
    .innerJoin(users, eq(emailAddresses.userId, users.id))
    .where(and(eq(emailAddresses.lowerEmail, lower), eq(emailAddresses.isActivated, true)))
    .get();
  if (secondary !== undefined) return secondary;
  const primary = await db
    .select({
      id: users.id,
      username: users.username,
      usernameLower: users.usernameLower,
      email: users.email,
      displayName: users.displayName,
      fullName: users.fullName,
      type: users.type,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${lower}`)
    .get();
  return primary ?? null;
}

/**
 * password.go:81-85's `!u.IsLocal() && !u.IsOAuth2()` predicate, expressed
 * over our substrate: a user with NO external-identity rows is local (the
 * Plain arm — every password-carrying account), one linked through an
 * OAuth2-type source is the allowed OAuth2 arm (upstream auto-registered
 * oauth2 users carry LoginType OAuth2 and ARE resettable). Any other link
 * source type (LDAP/SMTP/PAM/SSPI) refuses — unreachable in v1 (type 6 only,
 * the login_source schema note) but ported so the flash arm stays faithful.
 */
export async function resetAccountIsExternalOnly(d1: D1Database, userId: number): Promise<boolean> {
  const links = await drizzle(d1)
    .select({ type: loginSources.type })
    .from(externalLoginUsers)
    .innerJoin(loginSources, eq(externalLoginUsers.loginSourceId, loginSources.id))
    .where(eq(externalLoginUsers.userId, userId))
    .all();
  if (links.length === 0) return false; // local
  return !links.some((link) => link.type === OAUTH2_SOURCE_TYPE);
}

/**
 * password.go:87-91's resend-limit probe, ported over the outbox ledger (see
 * the header): any reset mail row carrying the upstream Info string for this
 * UID inside the TTL window arms the limit. Upstream keys the cache on
 * lowerName; the ledger's Info carries the UID — the same per-account key.
 */
export async function resetMailResendLimited(
  d1: D1Database,
  userId: number,
  now: Date,
  options: { seconds?: number } = {},
): Promise<boolean> {
  const seconds = options.seconds ?? MAIL_RESEND_LIMIT_SECONDS;
  const cutoff = new Date(now.getTime() - seconds * 1000);
  const row = await drizzle(d1)
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.info, `UID: ${userId}, recover account`), gt(emailOutbox.createdAt, cutoff)))
    .get();
  return row !== undefined;
}

/** The env slice the trigger reads (all vars; both bindings via outbox). */
export type ResetNotifyEnv = Pick<MailOutboxEnv, "DB" | "REPO_TASKS" | "APP_URL"> & {
  MAIL_ENABLED?: string;
  MAIL_FROM?: string;
};

export type ResetNotifyOutcome =
  | { outcome: "disabled" }
  | { outcome: "misconfigured"; message: string }
  | { outcome: "enqueued"; enqueue: EnqueueOutcome; mailId: number };

/** Upstream `DisplayName()` (models/user/user.go): FullName when set, else
 *  the username (the register-notify twin's fallback). */
function displayNameOf(user: ResetMailUser): string {
  const full = (user.displayName ?? user.fullName ?? "").trim();
  return full === "" ? user.username : full;
}

/**
 * `SendResetPasswordMail`'s port (mail_user.go:62-72 over sendUserMail:27-51):
 * gate → mint-side render → outbox. The CODE arrives pre-minted (the caller
 * generates through auth/reset-code.ts — the same HMAC machinery the
 * reset-COMPLETE arm verifies, user.go:952-963). Never throws for
 * disabled/misconfigured (upstream's MailService-nil arm returns silently;
 * a bad MAIL_FROM logs and skips — the register-notify posture); only a D1
 * failure propagates, and the route catches it (the § header posture).
 */
export async function enqueueResetPasswordMail(
  env: ResetNotifyEnv,
  user: ResetMailUser,
  options: { code: string; now?: Date },
): Promise<ResetNotifyOutcome> {
  // The master gate — upstream `MailService == nil` parity (SPEC §5.1:
  // strict polarity, only the exact "true" arms).
  if (env.MAIL_ENABLED !== "true") return { outcome: "disabled" };

  const from = parseMailFrom(env.MAIL_FROM ?? "");
  if (from === null) {
    const message = `[mail] MAIL_ENABLED=true but MAIL_FROM is missing or unparseable; skipping reset mail for UID ${user.id}`;
    console.warn(message);
    return { outcome: "misconfigured", message };
  }

  const appUrl = appUrlWithSlash(env.APP_URL);
  const body = renderResetPasswordMail({
    displayName: displayNameOf(user),
    resetPwdCodeLives: RESET_PWD_CODE_LIVES_FRIENDLY,
    code: options.code,
    appUrl,
    appName: GITEA_APP_NAME,
  });

  // Upstream `msg.Info = fmt.Sprintf("UID: %d, %s", u.ID, "recover account")`
  // (mail_user.go:49 — sendUserMail's info arg); the To is `u.EmailTo()` —
  // the PRIMARY address even when the lookup matched a secondary one.
  const enqueue = await enqueueMailOutbox(
    env,
    {
      info: `UID: ${user.id}, recover account`,
      fromAddress: from.address,
      fromDisplayName: from.displayName,
      toAddr: user.email ?? "",
      replyTo: null,
      subject: resetPasswordMailSubject(),
      bodyHtml: body,
      headers: null,
      dedupeKey: null,
    },
    { now: options.now },
  );
  return { outcome: "enqueued", enqueue, mailId: enqueue.mailId };
}
