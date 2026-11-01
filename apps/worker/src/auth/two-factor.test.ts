/**
 * The two_factor seam's tests (real D1, migration 0059 applied): the
 * enrollment round-trip (the mission's gate), the consume/replay ladder
 * over the PERIOD guard, the scratch burn, the disable arm's code
 * requirement, the pending-ticket codec (the AES-256-GCM seal: kind
 * separation, tamper, expiry, confidentiality — the TOTP secret never
 * rides the cookie in the clear), and the otpauth URI's pquerna-exact
 * bytes.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";
import {
  TWOFA_COOKIE_NAME,
  applyTwofaDisable,
  applyTwofaEnrollment,
  clearTwofaSetCookie,
  generateTotpSecret,
  getTwoFactorByUid,
  hasTwoFactorByUid,
  mintPendingTicket,
  otpauthUri,
  regenerateScratchToken,
  resetTwofaSigningSecretCache,
  twofaIssuer,
  twofaSetCookie,
  validateAndConsumeTotp,
  verifyPendingTicket,
  verifyScratchToken,
} from "./two-factor";
import { totpCode, totpPeriodAt } from "./totp";

const NOW = new Date(1_700_000_000_000); // fixed instant — every arm is time-controlled

async function enrollFixture(userId: number): Promise<{ secret: string; scratchToken: string }> {
  const secret = generateTotpSecret();
  const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret }, NOW);
  const outcome = await applyTwofaEnrollment(env.DB, userId, await totpCode(secret, NOW.getTime() / 1000), ticket, {
    now: NOW,
  });
  if (outcome.outcome !== "enrolled") throw new Error(`fixture enrollment failed: ${outcome.outcome}`);
  return { secret, scratchToken: outcome.scratchToken };
}

beforeAll(applyAuthD1Migrations);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM two_factor").run();
  await env.DB.prepare("DELETE FROM system_keystore").run();
  // the module-level signing-secret cache must follow the row wipe (the
  // keys.ts test-reset precedent)
  resetTwofaSigningSecretCache();
});

describe("the enrollment round-trip (security/2fa.go's EnrollTwoFactorPost arms)", () => {
  it("verifies once, activates, and shows the scratch token once (only salt+hash stored)", async () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{64}$/); // 40 bytes → 64 base32 chars (SecretSize 40)

    const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret }, NOW);
    const outcome = await applyTwofaEnrollment(env.DB, 7, await totpCode(secret, NOW.getTime() / 1000), ticket, {
      now: NOW,
    });
    expect(outcome.outcome).toBe("enrolled");
    if (outcome.outcome !== "enrolled") return;
    expect(outcome.scratchToken).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);

    const row = await getTwoFactorByUid(env.DB, 7);
    expect(row).not.toBeNull();
    expect(row?.secret).toBe(secret); // the base32-at-rest posture (the recorded divergence)
    expect(row?.lastUsedPasscodePeriod).toBe(0);
    expect(await verifyScratchToken(row as NonNullable<typeof row>, outcome.scratchToken)).toBe(true);

    expect(await hasTwoFactorByUid(env.DB, 7)).toBe(true);
  });

  it("a wrong passcode keeps the pending stash alive (upstream re-shows the same secret)", async () => {
    const secret = generateTotpSecret();
    const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret }, NOW);
    const outcome = await applyTwofaEnrollment(env.DB, 7, "000000", ticket, { now: NOW });
    expect(outcome).toEqual({ outcome: "invalid-passcode" });
    expect(await hasTwoFactorByUid(env.DB, 7)).toBe(false);
    // the same ticket still enrolls after the failed attempt
    const retry = await applyTwofaEnrollment(env.DB, 7, await totpCode(secret, NOW.getTime() / 1000), ticket, {
      now: NOW,
    });
    expect(retry.outcome).toBe("enrolled");
  });

  it("no ticket / a GATE-kind ticket is the no-pending-secret arm (twofa_failed_get_secret)", async () => {
    expect(await applyTwofaEnrollment(env.DB, 7, "123456", null, { now: NOW })).toEqual({
      outcome: "no-pending-secret",
    });
    const gateTicket = await mintPendingTicket(env.DB, { kind: "gate", userId: 7, remember: true, redirectTo: "/" }, NOW);
    expect(await applyTwofaEnrollment(env.DB, 7, "123456", gateTicket, { now: NOW })).toEqual({
      outcome: "no-pending-secret",
    });
  });

  it("an already-enrolled user refuses re-enrollment (the pre-check arm + the insert race)", async () => {
    const { secret } = await enrollFixture(7);
    const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret }, NOW);
    expect(
      await applyTwofaEnrollment(env.DB, 7, await totpCode(secret, NOW.getTime() / 1000), ticket, { now: NOW }),
    ).toEqual({ outcome: "already-enrolled" });
  });
});

describe("ValidateAndConsumeTOTP over the PERIOD guard (twofactor.go:127-143's port)", () => {
  it("consumes once, rejects the replay, accepts the next period's code", async () => {
    const { secret } = await enrollFixture(7);
    const row = (await getTwoFactorByUid(env.DB, 7)) as NonNullable<Awaited<ReturnType<typeof getTwoFactorByUid>>>;

    const code = await totpCode(secret, NOW.getTime() / 1000);
    expect(await validateAndConsumeTotp(env.DB, row, code, { now: NOW })).toBe(true);

    // the SAME code again — the replay — matches zero rows
    expect(await validateAndConsumeTotp(env.DB, row, code, { now: NOW })).toBe(false);

    // a FRESH row read (the caller reloads), the next 30 s step's code
    const row2 = (await getTwoFactorByUid(env.DB, 7)) as NonNullable<Awaited<ReturnType<typeof getTwoFactorByUid>>>;
    const nextCode = await totpCode(secret, NOW.getTime() / 1000 + 30);
    expect(await validateAndConsumeTotp(env.DB, row2, nextCode, { now: new Date(NOW.getTime() + 30_000) })).toBe(true);

    // the consumed period is the matched one
    const row3 = await getTwoFactorByUid(env.DB, 7);
    expect(row3?.lastUsedPasscodePeriod).toBe(totpPeriodAt(NOW.getTime() / 1000 + 30));
  });

  it("an OLDER window's code is rejected after a newer one consumed (strictly monotonic — stronger than upstream's string compare)", async () => {
    const { secret } = await enrollFixture(7);
    const row = (await getTwoFactorByUid(env.DB, 7)) as NonNullable<Awaited<ReturnType<typeof getTwoFactorByUid>>>;
    const future = new Date(NOW.getTime() + 30_000);
    expect(await validateAndConsumeTotp(env.DB, row, await totpCode(secret, future.getTime() / 1000), { now: future })).toBe(true);
    const row2 = (await getTwoFactorByUid(env.DB, 7)) as NonNullable<Awaited<ReturnType<typeof getTwoFactorByUid>>>;
    // NOW's code is inside the ±1 window of `future`, but its period is OLDER
    expect(await validateAndConsumeTotp(env.DB, row2, await totpCode(secret, NOW.getTime() / 1000), { now: future })).toBe(false);
  });
});

describe("the scratch code (generate → verify → burn)", () => {
  it("verifies the enrollment token, dies at regeneration, arms the new one", async () => {
    const { scratchToken } = await enrollFixture(7);
    let row = (await getTwoFactorByUid(env.DB, 7)) as NonNullable<Awaited<ReturnType<typeof getTwoFactorByUid>>>;
    expect(await verifyScratchToken(row, scratchToken)).toBe(true);

    const fresh = await regenerateScratchToken(env.DB, row, { now: NOW });
    expect(fresh).not.toBe(scratchToken);
    row = (await getTwoFactorByUid(env.DB, 7)) as NonNullable<Awaited<ReturnType<typeof getTwoFactorByUid>>>;
    expect(await verifyScratchToken(row, scratchToken)).toBe(false); // the burn
    expect(await verifyScratchToken(row, fresh)).toBe(true);
  });
});

describe("the disable arm (security/2fa.go's DisableTwoFactor + the mission's code requirement)", () => {
  it("requires a code: empty/junk is invalid-code and the row survives", async () => {
    await enrollFixture(7);
    expect(await applyTwofaDisable(env.DB, 7, "", { now: NOW })).toEqual({ outcome: "invalid-code" });
    expect(await applyTwofaDisable(env.DB, 7, "000000", { now: NOW })).toEqual({ outcome: "invalid-code" });
    expect(await hasTwoFactorByUid(env.DB, 7)).toBe(true);
  });

  it("a live TOTP passcode disables without consuming it", async () => {
    const { secret } = await enrollFixture(7);
    const code = await totpCode(secret, NOW.getTime() / 1000);
    expect(await applyTwofaDisable(env.DB, 7, code, { now: NOW })).toEqual({ outcome: "disabled" });
    expect(await hasTwoFactorByUid(env.DB, 7)).toBe(false);
    const row = await getTwoFactorByUid(env.DB, 7);
    expect(row).toBeNull();
  });

  it("the scratch token disables WITHOUT burning it (the row is simply deleted)", async () => {
    const { scratchToken } = await enrollFixture(7);
    expect(await applyTwofaDisable(env.DB, 7, scratchToken, { now: NOW })).toEqual({ outcome: "disabled" });
    expect(await getTwoFactorByUid(env.DB, 7)).toBeNull();
  });

  it("a not-enrolled user is the not-enrolled arm (upstream's flash-and-redirect)", async () => {
    expect(await applyTwofaDisable(env.DB, 42, "123456", { now: NOW })).toEqual({ outcome: "not-enrolled" });
  });
});

describe("the pending-ticket codec", () => {
  it("round-trips a gate ticket; the TTL arms at mint+24h (inclusive expiry)", async () => {
    const ticket = await mintPendingTicket(env.DB, { kind: "gate", userId: 9, remember: true, redirectTo: "/alice/repo" }, NOW);
    expect(await verifyPendingTicket(env.DB, ticket, "gate", { now: NOW })).toEqual({
      kind: "gate",
      userId: 9,
      remember: true,
      redirectTo: "/alice/repo",
    });
    expect(
      await verifyPendingTicket(env.DB, ticket, "gate", { now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000 - 1) }),
    ).toEqual({
      kind: "gate",
      userId: 9,
      remember: true,
      redirectTo: "/alice/repo",
    });
    // at exactly iat+TTL the guard `iat + TTL <= now` expires it
    expect(
      await verifyPendingTicket(env.DB, ticket, "gate", { now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) }),
    ).toBeNull();
  });

  it("kinds never cross-authenticate; tampering and junk are null", async () => {
    const enroll = await mintPendingTicket(env.DB, { kind: "enroll", secret: generateTotpSecret() }, NOW);
    expect(await verifyPendingTicket(env.DB, enroll, "gate", { now: NOW })).toBeNull();
    expect(await verifyPendingTicket(env.DB, enroll, "enroll", { now: NOW })).not.toBeNull();

    // AEAD wire: ONE dotless base64url token — a flipped ciphertext byte
    // breaks the GCM tag (the folded HMAC's role) and verifies null.
    const gate = await mintPendingTicket(env.DB, { kind: "gate", userId: 9, remember: false, redirectTo: "/" }, NOW);
    expect(gate).toMatch(/^[A-Za-z0-9_-]+$/);
    const mid = Math.floor(gate.length / 2);
    const flippedChar = gate[mid] === "A" ? "B" : "A";
    const tampered = gate.slice(0, mid) + flippedChar + gate.slice(mid + 1);
    expect(tampered).not.toBe(gate);
    expect(await verifyPendingTicket(env.DB, tampered, "gate", { now: NOW })).toBeNull();
    // a trailing truncation (tag bytes shorn) is null too
    expect(await verifyPendingTicket(env.DB, gate.slice(0, gate.length - 8), "gate", { now: NOW })).toBeNull();

    expect(await verifyPendingTicket(env.DB, "garbage", "gate", { now: NOW })).toBeNull();
    // the RETIRED HMAC format (`body.mac`, no version byte) fails the
    // length/version gates outright — outstanding pre-AEAD cookies die at
    // the format switch instead of verifying under any key
    expect(await verifyPendingTicket(env.DB, `aGVsbG8.yWJj`, "gate", { now: NOW })).toBeNull();

    // a ticket minted under a DIFFERENT instance secret (the keystore row
    // rotated out-of-band) is null — the operator-rotation posture
    await env.DB.prepare("DELETE FROM system_keystore").run();
    resetTwofaSigningSecretCache(); // the isolate-restart half of the rotation
    expect(await verifyPendingTicket(env.DB, gate, "gate", { now: NOW })).toBeNull();
  });

  it("the ENROLL ticket does not leak the TOTP secret (AES-GCM confidentiality — the item the HMAC shape failed)", async () => {
    const secret = generateTotpSecret();
    const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret }, NOW);
    // the base32 secret is not a readable substring of the sealed cookie
    expect(ticket).not.toContain(secret);
    // …nor do its raw ASCII bytes survive anywhere in the DECODED wire
    // (version byte + IV + ciphertext + tag): a 64-byte needle cannot
    // occur in a ~110-byte buffer by chance, so this arm is deterministic
    const binary = atob(ticket.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (ticket.length % 4)) % 4));
    const secretBytes = new TextEncoder().encode(secret);
    let byteHit = false;
    for (let i = 0; i + secretBytes.length <= binary.length; i++) {
      let match = true;
      for (let j = 0; j < secretBytes.length; j++) {
        if (binary.charCodeAt(i + j) !== secretBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) byteHit = true;
    }
    expect(byteHit).toBe(false);
    // the round-trip still recovers the exact secret for the verify
    const opened = await verifyPendingTicket(env.DB, ticket, "enroll", { now: NOW });
    expect(opened).toEqual({ kind: "enroll", secret });
    // two seals of the same payload differ (a fresh random IV per mint)
    const again = await mintPendingTicket(env.DB, { kind: "enroll", secret }, NOW);
    expect(again).not.toBe(ticket);
  });

  it("the cookie directives carry the §2.3 flag set", () => {
    expect(twofaSetCookie("a.b")).toBe(
      `${TWOFA_COOKIE_NAME}=a.b; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(clearTwofaSetCookie()).toBe(`${TWOFA_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  });
});

describe("the otpauth URI + issuer (pquerna v1.5.0 bytes)", () => {
  it("renders the sorted, PathEscaped query with ALL default members set", () => {
    expect(otpauthUri("JBSWY3DPEHPK3PXP", "Gitea (test.local)", "alice@example.com")).toBe(
      "otpauth://totp/Gitea%20(test.local):alice@example.com" +
        "?algorithm=SHA1&digits=6&issuer=Gitea%20(test.local)&period=30&secret=JBSWY3DPEHPK3PXP",
    );
  });

  it("twofaIssuer derives AppDomain from APP_URL and strips ':' (security/2fa.go:117)", () => {
    expect(twofaIssuer("https://cf-gitea.example.workers.dev/")).toBe("Gitea (cf-gitea.example.workers.dev)");
    expect(twofaIssuer("not a url")).toBe("Gitea");
    expect(twofaIssuer(undefined)).toBe("Gitea");
  });
});
