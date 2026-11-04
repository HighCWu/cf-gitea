/**
 * The time-limit code machinery — the port of upstream modules/base/tool.go
 * (CreateTimeLimitCode/VerifyTimeLimitCode, tool.go:35-92) and the user
 * binding (models/user/user.go:938-973) at pin v29.0.0-dev-208-gfc493688.
 * SPEC-0002 §6.3-7 (ADR-0008: mirror the byte format, don't invent one).
 *
 * Format (tool.go:60): `YYYYMMDDHHmm` (12) + minutes zero-padded (6) +
 * hex(HMAC-SHA1) (40) = 58 chars, then the hex(lowerName) tail
 * (user.go:962 — the tail resolves the user BEFORE verification,
 * GetVerifyUser user.go:920-936). The HMAC input is
 * `data + hex(secret) + startStr + endStr + minutes` keyed with the
 * general token signing secret (tool.go:82-84, setting
 * GetGeneralTokenSigningSecret) — the same system_keystore row the
 * WebAuthn ceremony signs with (`general_token_signing_secret`).
 *
 * Hash data (user.go:948-950): `purpose|uid|lowerEmail|lowerName|passwd|rands`
 * — the passwd/rands fields make a successful reset INVALIDATE the code de
 * facto (one-time without a store; the data hash no longer recomputes).
 *
 * Recorded divergence: upstream parses/formats the start time in
 * time.Local (tool.go:71-78); there is no process-local timezone on
 * Workers, so both arms run UTC — self-consistent (a code is generated and
 * verified by the same instance semantics), invisible on the wire.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { userRedirects, users } from "../db/schema";
import { bytesToHex } from "./password";
import { KEYSTORE_SECRET_ROW } from "../web/webauthn-ceremony";

/** tool.go:56-57. */
export const TIME_LIMIT_CODE_LENGTH = 12 + 6 + 40;

/** service.go:146 — `ACTIVE_CODE_LIVE_MINUTES` MustInt(180). */
export const ACTIVE_CODE_LIVES_MINUTES = 180;

/** user.go:943-944 TimeLimitCodePurpose — Phase A carries the reset one. */
export type TimeLimitCodePurpose = "reset_password";

// ---------------------------------------------------------------------------
// The signing secret (tool.go:82 — GetGeneralTokenSigningSecret). The same
// system_keystore row the WebAuthn ceremony uses; read-or-create-once, the
// ceremony's posture (a cold instance generates-once-saves-back).
// ---------------------------------------------------------------------------

async function generalTokenSigningSecretBytes(d1: D1Database): Promise<Uint8Array> {
  const { systemKeystore } = await import("../db/schema");
  const db = drizzle(d1);
  const row = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
  if (row !== undefined) {
    const parsed = JSON.parse(row.value) as { tokenSigningSecret?: unknown };
    if (typeof parsed.tokenSigningSecret === "string" && parsed.tokenSigningSecret !== "") {
      return hexToBytes(parsed.tokenSigningSecret);
    }
    throw new Error("reset-code: keystore secret row is malformed");
  }
  const generated = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  await db
    .insert(systemKeystore)
    .values({ name: KEYSTORE_SECRET_ROW, value: JSON.stringify({ v: 1, tokenSigningSecret: generated }), createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  const winner = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
  if (winner === undefined) throw new Error("reset-code: keystore secret row missing after insert (D1 write failed?)");
  const parsed = JSON.parse(winner.value) as { tokenSigningSecret?: unknown };
  if (typeof parsed.tokenSigningSecret !== "string" || parsed.tokenSigningSecret === "") {
    throw new Error("reset-code: keystore secret row is malformed");
  }
  return hexToBytes(parsed.tokenSigningSecret);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** tool.go:81-85 — HMAC-SHA1(secret, data+hex(secret)+start+end+minutes). */
async function timeLimitCodeHash(
  d1: D1Database,
  data: string,
  startStr: string,
  endStr: string,
  minutes: number,
): Promise<string> {
  const secret = await generalTokenSigningSecretBytes(d1);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const secretHex = bytesToHex(secret);
  const payload = new TextEncoder().encode(`${data}${secretHex}${startStr}${endStr}${minutes}`);
  const mac = await crypto.subtle.sign("HMAC", key, payload);
  return bytesToHex(new Uint8Array(mac));
}

/** `YYYYMMDDHHmm` (UTC — the recorded divergence note, module header). */
function formatMinuteStamp(date: Date): string {
  const p = (n: number, width: number): string => String(n).padStart(width, "0");
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1, 2)}${p(date.getUTCDate(), 2)}` +
    `${p(date.getUTCHours(), 2)}${p(date.getUTCMinutes(), 2)}`
  );
}

function parseMinuteStamp(stamp: string): Date | null {
  if (!/^\d{12}$/.test(stamp)) return null;
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(8, 10));
  const minute = Number(stamp.slice(10, 12));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

/**
 * tool.go:62-92 CreateTimeLimitCode — the exact byte layout. Returns ""
 * for an unparsable startStr (the tool.go:72-74 invalid-code answer).
 */
export async function createTimeLimitCode(
  d1: D1Database,
  data: string,
  minutes: number,
  start: Date | string,
): Promise<string> {
  const startTime = start instanceof Date ? start : parseMinuteStamp(start);
  if (startTime === null) return "";
  const startStr = formatMinuteStamp(startTime);
  const endStr = formatMinuteStamp(new Date(startTime.getTime() + minutes * 60_000));
  const hash = await timeLimitCodeHash(d1, data, startStr, endStr, minutes);
  return `${startStr}${String(minutes).padStart(6, "0")}${hash}`;
}

/**
 * tool.go:36-54 VerifyTimeLimitCode — recompute with the code's OWN start +
 * aliveTime (the :43 Atoi of code[12:18]), compare constant-time, then the
 * window against the CALLER's minutes (`now < start + minutes`, :53).
 */
export async function verifyTimeLimitCode(
  d1: D1Database,
  now: Date,
  data: string,
  minutes: number,
  code: string,
): Promise<boolean> {
  if (code.length <= 18) return false;
  const startStr = code.slice(0, 12);
  const aliveTimeStr = code.slice(12, 18);
  const aliveTime = Number.parseInt(aliveTimeStr, 10);
  if (!Number.isInteger(aliveTime)) return false;
  const recomputed = await createTimeLimitCode(d1, data, aliveTime, startStr);
  if (recomputed === "" || !constantTimeEqual(recomputed, code)) return false;
  const start = parseMinuteStamp(startStr);
  if (start === null) return false;
  return start.getTime() <= now.getTime() && now.getTime() < start.getTime() + minutes * 60_000;
}

/** tool.go:47 ConstantTimeCompare shape. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The user binding (user.go:938-973)
// ---------------------------------------------------------------------------

/** user.go:948-950 makeTimeLimitCodeHashData. */
export function timeLimitCodeHashData(
  purpose: TimeLimitCodePurpose,
  user: Pick<typeof users.$inferSelect, "id" | "email" | "usernameLower" | "passwd" | "rands">,
  newEmail?: string,
): string {
  return `${purpose}|${user.id}|${(newEmail ?? user.email ?? "").toLowerCase()}|${user.usernameLower}|${user.passwd}|${user.rands}`;
}

/**
 * user.go:952-963 GenerateUserTimeLimitCode — the code + the hex(lowerName)
 * tail (resolved BEFORE verification by GetVerifyUser).
 */
export async function generateUserTimeLimitCode(
  d1: D1Database,
  purpose: TimeLimitCodePurpose,
  user: typeof users.$inferSelect,
  options?: { now?: Date; minutes?: number },
): Promise<string> {
  const minutes = options?.minutes ?? ACTIVE_CODE_LIVES_MINUTES;
  const data = timeLimitCodeHashData(purpose, user);
  const code = await createTimeLimitCode(d1, data, minutes, options?.now ?? new Date());
  return `${code}${bytesToHex(new TextEncoder().encode(user.usernameLower))}`;
}

/**
 * user.go:920-936 GetVerifyUser — the tail resolves the user: decode the
 * hex tail as the lowerName (redirect-aware lookup, upstream GetUserByName
 * follows user_redirects), individuals only.
 */
async function getVerifyUser(d1: D1Database, code: string): Promise<typeof users.$inferSelect | null> {
  if (code.length <= TIME_LIMIT_CODE_LENGTH) return null;
  const hexTail = code.slice(TIME_LIMIT_CODE_LENGTH);
  if (!/^[0-9a-f]*$/.test(hexTail) || hexTail.length % 2 !== 0) return null;
  const bytes = hexToBytes(hexTail);
  const lowerName = new TextDecoder().decode(bytes);
  if (lowerName === "") return null;
  const db = drizzle(d1);
  const direct =
    (await db
      .select()
      .from(users)
      .where(eq(users.usernameLower, lowerName))
      .get()) ?? null;
  if (direct !== null && direct.type === "user") return direct;
  // GetUserByName follows the redirect table (user.go:932's GetUserByName).
  const redirect = await db
    .select({ lowerName: userRedirects.lowerName })
    .from(userRedirects)
    .where(eq(userRedirects.lowerName, lowerName))
    .get();
  if (redirect === undefined) return null;
  const redirected =
    (await db
      .select()
      .from(users)
      .where(eq(users.usernameLower, redirect.lowerName))
      .get()) ?? null;
  return redirected !== null && redirected.type === "user" ? redirected : null;
}

/**
 * user.go:965-973 VerifyUserTimeLimitCode — resolve the user from the tail,
 * recompute the hash data FROM THE ROW, verify (TTL + the byte compare).
 * Returns the row or null; callers treat null as the invalid-code arm.
 */
export async function verifyUserTimeLimitCode(
  d1: D1Database,
  purpose: TimeLimitCodePurpose,
  code: string,
  options?: { now?: Date },
): Promise<typeof users.$inferSelect | null> {
  const user = await getVerifyUser(d1, code);
  if (user === null) return null;
  const data = timeLimitCodeHashData(purpose, user);
  const valid = await verifyTimeLimitCode(d1, options?.now ?? new Date(), data, ACTIVE_CODE_LIVES_MINUTES, code.slice(0, TIME_LIMIT_CODE_LENGTH));
  return valid ? user : null;
}
