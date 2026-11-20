/**
 * The per-account failed-TOTP-attempt limiter + the twofa-failure audit row —
 * the SHARED home every TOTP surface adopts (ui/session.ts's gate + reset
 * arms, auth/middleware.ts's API-Basic ladder, git-http/acl.ts's git arm).
 * Landed in ui/session.ts by c54ec52f0f; lifted here so the non-UI surfaces
 * consume the SAME counter without importing the UI session module.
 *
 * ValidateAndConsumeTOTP's per-account failed-attempt limiter
 * (twofactor.go:143-190): 5 failed attempts (totpMaxAttempts, :55) refuse
 * TOTP until 15 minutes after the LAST failure (totpAttemptsTTL, :56 —
 * renewed by every failure); a success clears the counter; the locked arm
 * extends nothing; empty passcodes never consume an attempt (:150-153, the
 * password-only Basic posture); the scratch and WebAuthn arms never touch
 * the counter (the recovery path stays usable while locked).
 *
 * PLATFORM (the cache → D1 adaptation): upstream rides the shared cache
 * behind a globallock spanning check+validate+count ("With Redis, both are
 * shared across instances"). Workers has neither; the counter lives in
 * user_settings_kv (upstream's OWN user_setting store port — a D1 row is
 * shared across isolates the same way) under the fixed lowercase key below
 * (upstream's `twofa_attempts_<uid>` — the uid rides the row's user_id),
 * and the lock's guarantee is carried by the RESERVE: a single conditional
 * UPDATE (`count < 5 OR expired`) whose matched-rows verdict IS the check,
 * so concurrent racers cannot widen the limit — a 6th attempt's reserve
 * matches zero rows and is refused before any validation, exactly
 * upstream's locked check arm. Value shape `<epoch>:<count>` (the epoch is
 * fixed-width 10 digits — the window slide is the row's own TTL). Only
 * wrong/replayed passcodes hold their slot (a success clears; the
 * locked-at-arm does not write — upstream's blocked branch has no Put). A
 * mid-attempt D1 failure may hold a reserved slot (logged) — upstream's
 * "server errors do not count" narrows to that disclosed rare path.
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { userSettingsKv } from "../db/schema";
import { AuditActions, auditClientIp, emitAudit, type AuditOrigin } from "../services/audit";
import { validateAndConsumeTotp, type TwoFactorRow } from "./two-factor";

const TOTP_ATTEMPTS_KEY = "twofa_totp_attempts"; // userSettingKey is lowercase-validated (setting.go:116-124)
const TOTP_MAX_ATTEMPTS = 5; // twofactor.go:55 totpMaxAttempts
const TOTP_ATTEMPTS_TTL_SECONDS = 15 * 60; // twofactor.go:56 totpAttemptsTTL

/**
 * Reserve one attempt slot: true = proceed to validation, false = the
 * counter is locked (TooManyAttempts). The reserve IS the check — the
 * conditional UPDATE only matches a live window with headroom, so the
 * verdict cannot race.
 */
export async function reserveTotpAttempt(d1: D1Database, userId: number, now: Date): Promise<boolean> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const cutoff = nowSec - TOTP_ATTEMPTS_TTL_SECONDS;
  const nowText = String(nowSec); // TEXT-bound: a numeric param renders REAL ("….0") in the concat
  const freshValue = `${nowText}:1`; // <epoch10>:<count>
  const db = drizzle(d1);
  const epoch = userSettingsKv.settingValue;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reserved = await db
      .update(userSettingsKv)
      .set({
        settingValue: sql`case when cast(substr(${epoch}, 1, 10) as integer) <= ${cutoff}
          then ${freshValue}
          else ${nowText} || ':' || (cast(substr(${epoch}, 12) as integer) + 1) end`,
      })
      .where(
        and(
          eq(userSettingsKv.userId, userId),
          eq(userSettingsKv.settingKey, TOTP_ATTEMPTS_KEY),
          sql`(cast(substr(${epoch}, 1, 10) as integer) <= ${cutoff} or cast(substr(${epoch}, 12) as integer) < ${TOTP_MAX_ATTEMPTS})`,
        ),
      )
      .returning({ id: userSettingsKv.id });
    if (reserved.length > 0) return true;
    // Zero rows: locked, expired-unwritten, or no row yet. One read tells
    // which; a racer flipping state between the UPDATE and the read loops
    // the retry (upstream's lock acquisition retried under contention).
    const existing = await db
      .select({ settingValue: userSettingsKv.settingValue })
      .from(userSettingsKv)
      .where(and(eq(userSettingsKv.userId, userId), eq(userSettingsKv.settingKey, TOTP_ATTEMPTS_KEY)))
      .get();
    if (existing === undefined) {
      const inserted = await db
        .insert(userSettingsKv)
        .values({ userId, settingKey: TOTP_ATTEMPTS_KEY, settingValue: `${nowSec}:1` })
        .onConflictDoNothing()
        .returning({ id: userSettingsKv.id });
      if (inserted.length > 0) return true; // the fresh counter is the reserve
      continue; // a racer inserted first — retry the reserve
    }
    const [epochStr, countStr] = existing.settingValue.split(":");
    const seenEpoch = Number.parseInt(epochStr ?? "", 10);
    const seenCount = Number.parseInt(countStr ?? "", 10);
    if (Number.isFinite(seenEpoch) && Number.isFinite(seenCount) && nowSec - seenEpoch < TOTP_ATTEMPTS_TTL_SECONDS && seenCount >= TOTP_MAX_ATTEMPTS) {
      return false; // LOCKED — upstream's attempts >= totpMaxAttempts arm
    }
    // Expired window or unparseable value (upstream's Atoi error → 0, the
    // fail-open posture): the next UPDATE iteration resets it.
  }
  console.error(`totp-attempts: attempt reserve raced twice for user ${userId} — refusing (fail-closed)`);
  return false;
}

/** The success arm — upstream's cache.Remove (twofactor.go:184). */
export async function clearTotpAttempts(d1: D1Database, userId: number): Promise<void> {
  await drizzle(d1)
    .delete(userSettingsKv)
    .where(and(eq(userSettingsKv.userId, userId), eq(userSettingsKv.settingKey, TOTP_ATTEMPTS_KEY)))
    .run();
}

/**
 * The tri-state verdict upstream's `ValidateAndConsumeTOTP` answers
 * (twofactor.go:145-190, the TwoFactorResult enum :131-135) — every TOTP
 * login surface goes through THIS helper (upstream's own doc line :147-148):
 *
 *   - an EMPTY passcode answers "invalid" WITHOUT consuming an attempt
 *     (:150-153 — password-only Basic clients must not burn the counter);
 *   - a locked counter answers "too-many" BEFORE any validation, writing
 *     nothing (:162-166 — the lock does not extend);
 *   - "invalid" held its reserved slot (renewing the 15-min window — the
 *     reserve above IS the failed-attempt record);
 *   - "valid" clears the counter (cache.Remove, :184).
 */
export async function consumeTotpWithAttemptLimit(
  d1: D1Database,
  twofa: TwoFactorRow,
  passcode: string,
  now: Date,
): Promise<"valid" | "invalid" | "too-many"> {
  if (passcode === "") return "invalid"; // no attempt consumed (twofactor.go:150-153)
  if (!(await reserveTotpAttempt(d1, twofa.userId, now))) return "too-many";
  if (await validateAndConsumeTotp(d1, twofa, passcode, { now })) {
    await clearTotpAttempts(d1, twofa.userId); // upstream's cache.Remove on success
    return "valid";
  }
  return "invalid";
}

/**
 * The failed-TOTP/failed-scratch audit row — `audit.RecordAs(ctx, u,
 * UserAuthenticationFailTwoFactor, u)` (password.go:183 wrong scratch /
 * :199 wrong passcode at the pin; 2fa.go:87-91 gate / :163-168 scratch —
 * c144668e59's authentication-events sweep; basic.go:182 the Basic arms).
 * Upstream fires the row for EVERY non-valid result — the TooManyAttempts
 * branch sits AFTER the RecordAs (basic.go:182-188) — so the locked arm
 * records too.
 *
 * The request is pre-sign-in, so actor = scope = the target — the only
 * principal both sides can name; a session-less write carries no
 * credential; the caller's request address rides along. `origin` is the
 * caller's mounted chain (upstream common.AuditOrigin — OriginUI over the
 * web routes, web.go:300, whose mid list carries the git smart-HTTP mounts
 * too; OriginAPI over the v1 router, api.go:971). Best-effort: an audit
 * row never fails the auth arm (the writeEvent posture, event.go:136-140).
 * The registry id landed with ACTIONS2/ADMINUSER2's append (audit.ts).
 */
export async function emitTwofaFailureAudit(
  d1: D1Database,
  subject: { id: number; username: string },
  req: Request,
  origin: AuditOrigin,
): Promise<void> {
  try {
    await emitAudit(drizzle(d1), {
      action: AuditActions.UserAuthenticationFailTwoFactor,
      actorId: subject.id,
      actorName: subject.username,
      actorCredential: null,
      scopeType: "user",
      scopeId: subject.id,
      scopeName: subject.username,
      origin,
      ipAddress: auditClientIp(req.headers),
      vars: { scope: subject.username },
    });
  } catch (error) {
    console.error(`totp-attempts: unable to record the twofa-failure audit row: ${String(error)}`);
  }
}
