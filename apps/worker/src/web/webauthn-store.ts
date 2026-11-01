/**
 * The WebAuthn credential store — D1 through Drizzle, the port of upstream
 * `models/auth/webauthn.go`'s operations (the table is migration 0060, the
 * schema comment carries the exact-column mapping):
 *
 *   CreateCredential (:180-196)          → createCredential
 *   GetWebAuthnCredentialsByUID (:131)   → listCredentialsByUser
 *   ExistsWebAuthnCredentialsForUID(:137)/HasWebAuthnRegistrationsByUID
 *                                        → hasCredentialsForUser
 *   GetWebAuthnCredentialByName (:142)   → getCredentialByName
 *   GetWebAuthnCredentialByID (:153)     → getCredentialById (row id)
 *   GetWebAuthnCredentialByCredID (:169) → getCredentialByCredentialId
 *   RenameCredential (:199-214)          → renameCredential
 *   DeleteCredential (:217-220)          → deleteCredential
 *   UpdateSignCount (:70-73)             → applyAssertionSignCount (the CAS)
 *
 * The bytes columns are bare `blob()` (the actions tables' posture): rows
 * coerce through `asBytes` into the module's `WebAuthnCredential` view — the
 * shape every consumer (router, settings page) sees.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { webauthnCredentials } from "../db/schema";
import { parseCoseKey, type CoseKey } from "./webauthn-cose";
import type { VerifiedRegistration } from "./webauthn-ceremony";

/** The coerced credential view — the row with bytes as Uint8Array and the
 *  COSE key parsed once. */
export interface WebAuthnCredential {
  id: number;
  userId: number;
  name: string;
  lowerName: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  coseKey: CoseKey;
  attestationType: string;
  aaguid: Uint8Array | null;
  signCount: number;
  transports: string[] | null;
  cloneWarning: boolean;
  createdUnix: Date;
  updatedUnix: Date;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("webauthn: blob column did not return bytes");
}

function asOptionalBytes(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  return asBytes(value);
}

function asRow(row: typeof webauthnCredentials.$inferSelect): WebAuthnCredential {
  const publicKey = asBytes(row.publicKey);
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    lowerName: row.lowerName,
    credentialId: asBytes(row.credentialId),
    publicKey,
    coseKey: parseCoseKey(publicKey, 0).key,
    attestationType: row.attestationType,
    aaguid: asOptionalBytes(row.aaguid),
    signCount: row.signCount,
    transports: row.transports === null ? null : (JSON.parse(row.transports) as string[]),
    cloneWarning: row.cloneWarning,
    createdUnix: new Date(row.createdUnix * 1000),
    updatedUnix: new Date(row.updatedUnix * 1000),
  };
}

/** CreateCredential (webauthn.go:180-196) + BeforeInsert's lower_name fold
 *  (:76-79). `verified` is the registration ladder's output. Duplicate
 *  nickname/credential-id violations surface as the caller's 409 arms (the
 *  UNIQUE composites are the arbiter — a concurrent duplicate INSERT
 *  rejects at the index exactly like upstream's checked insert). */
export async function createCredential(d1: D1Database, userId: number, name: string, verified: VerifiedRegistration): Promise<WebAuthnCredential> {
  // The columns are PLAIN integers (unix seconds — the two_factor table's
  // style); the store writes seconds and reads Dates into the view.
  const now = Math.floor(Date.now() / 1000);
  const inserted = await drizzle(d1)
    .insert(webauthnCredentials)
    .values({
      userId,
      name,
      lowerName: name.toLowerCase(),
      credentialId: verified.credentialId,
      publicKey: verified.publicKeyRaw,
      attestationType: verified.attestationType,
      aaguid: verified.aaguid,
      signCount: verified.signCount,
      transports: verified.transports === null ? null : JSON.stringify(verified.transports),
      cloneWarning: false,
      createdUnix: now,
      updatedUnix: now,
    })
    .returning();
  return asRow(inserted[0]!);
}

/** GetWebAuthnCredentialsByUID (webauthn.go:131-134) — the settings list and
 *  the assertion options' allowlist read. */
export async function listCredentialsByUser(d1: D1Database, userId: number): Promise<WebAuthnCredential[]> {
  const rows = await drizzle(d1)
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .orderBy(webauthnCredentials.id);
  return rows.map(asRow);
}

/** ExistsWebAuthnCredentialsForUID / HasWebAuthnRegistrationsByUID — the
 *  login gate's check (upstream auth.go:351) and the assertion arm's
 *  "no device registered" (webauthn.go:177-185). */
export async function hasCredentialsForUser(d1: D1Database, userId: number): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ id: webauthnCredentials.id })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .limit(1)
    .get();
  return row !== undefined;
}

/** GetWebAuthnCredentialByName (webauthn.go:142-150) — the name-conflict
 *  arms. Name compare is case-folded (BeforeInsert's fold). */
export async function getCredentialByName(d1: D1Database, userId: number, name: string): Promise<WebAuthnCredential | null> {
  const row = await drizzle(d1)
    .select()
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, userId), eq(webauthnCredentials.lowerName, name.toLowerCase())))
    .get();
  return row === undefined ? null : asRow(row);
}

/** GetWebAuthnCredentialByID (webauthn.go:153-161) — the rename/delete
 *  target resolution. */
export async function getCredentialById(d1: D1Database, userId: number, id: number): Promise<WebAuthnCredential | null> {
  const row = await drizzle(d1)
    .select()
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, userId), eq(webauthnCredentials.id, id)))
    .get();
  return row === undefined ? null : asRow(row);
}

/** GetWebAuthnCredentialByCredID (webauthn.go:169-177) — the login
 *  assertion's credential resolution. */
export async function getCredentialByCredentialId(
  d1: D1Database,
  userId: number,
  credentialId: Uint8Array,
): Promise<WebAuthnCredential | null> {
  const row = await drizzle(d1)
    .select()
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, userId), eq(webauthnCredentials.credentialId, credentialId)))
    .get();
  return row === undefined ? null : asRow(row);
}

export type RenameOutcome = "renamed" | "name-taken" | "not-exist";

/** RenameCredential (webauthn.go:199-214): the per-user case-folded
 *  uniqueness probe first (the translatable-already-exist arm), then the
 *  update. `not-exist` is upstream's GetWebAuthnCredentialByID miss (the
 *  router's JSONErrorAuto 404-ish arm). */
export async function renameCredential(d1: D1Database, userId: number, id: number, name: string): Promise<RenameOutcome> {
  const existing = await getCredentialById(d1, userId, id);
  if (existing === null) return "not-exist";
  const lower = name.toLowerCase();
  if (lower !== existing.lowerName) {
    const clash = await getCredentialByName(d1, userId, name);
    if (clash !== null) return "name-taken";
  }
  if (name === existing.name) return "renamed"; // upstream's `name<>?` no-op arm
  await drizzle(d1)
    .update(webauthnCredentials)
    .set({ name, lowerName: lower, updatedUnix: Math.floor(Date.now() / 1000) })
    .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
    .run();
  return "renamed";
}

/** DeleteCredential (webauthn.go:217-220). */
export async function deleteCredential(d1: D1Database, userId: number, id: number): Promise<boolean> {
  const deleted = await drizzle(d1)
    .delete(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
    .run();
  return (deleted.meta.changes ?? 0) > 0;
}

export type SignCountOutcome = "applied" | "counter-moved";

/**
 * UpdateSignCount over the CAS (the module header's durable replay guard):
 * `sign_count = new WHERE id = ? AND sign_count = old` — exactly-once for
 * the accept arm; a lost CAS means a concurrent verify of the SAME response
 * (or a newer one) moved the counter first, which by the monotonic ladder
 * IS the clone arm: the caller answers 403 like upstream's CloneWarning
 * check. `clone` persists the warning flag (the recorded column divergence,
 * the schema comment) alongside.
 */
export async function applyAssertionSignCount(
  d1: D1Database,
  id: number,
  oldSignCount: number,
  newSignCount: number,
  clone: boolean,
): Promise<SignCountOutcome> {
  const updated = await drizzle(d1)
    .update(webauthnCredentials)
    .set({ signCount: newSignCount, cloneWarning: clone, updatedUnix: Math.floor(Date.now() / 1000) })
    .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.signCount, oldSignCount)))
    .run();
  return (updated.meta.changes ?? 0) > 0 ? "applied" : "counter-moved";
}
