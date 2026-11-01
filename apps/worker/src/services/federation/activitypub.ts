/**
 * The ActivityPub actor module (SPEC specs/federation.md §6.2, W-B2 as-built
 * 2026-11-01) — the port of upstream's deleted `modules/activitypub`
 * (`1592576fa5^`, retracted by PR #36789):
 *
 *   - the per-user RSA keypair (`user_settings.go`): RSA-3072
 *     (`rsaBits`, user_settings.go:14), lazily generated on first use,
 *     stored as PEM strings. Upstream's home was the `user_setting` KV under
 *     the (deleted) `UserActivityPubPrivPem`/`PubPem` setting keys; ours is
 *     the SAME store — `user_settings_kv` — under OUR key names
 *     `activitypub.priv_pem`/`activitypub.pub_pem` (the SPEC §4.2
 *     storage-home divergence, the debian.ts keypair pattern verbatim:
 *     generate → upsert → re-read, the stored pair authoritative either
 *     way). Keys are lowercase per the schema's validateUserSettingKey note
 *     (upstream setting.go:116-124 refuses mixed case).
 *   - the Person actor document (`routers/api/v1/activitypub/person.go` at
 *     `1592576fa5^`): actor IRI `{AppURL}/api/v1/activitypub/user-id/{id}`
 *     — numeric-ID IRIs, the username NOT in the path (SPEC §4.1, and the
 *     shape webfinger's `self` link already advertises); Name = FullName,
 *     PreferredUsername = username, URL = HTMLURL (`{appUrl}{username}`,
 *     the webfinger alias projection), Icon = the house canonical avatar
 *     URL (`{appUrl}avatars/{usernameLower}` — the Tier A divergence note 3;
 *     upstream's `AvatarLink` is gravatar-config dependent, nothing to
 *     port), Inbox = `{actorIRI}/inbox`, Outbox = `{actorIRI}/outbox`
 *     (declared only — upstream never had an outbox handler and none is
 *     invented), publicKey = `{actorIRI}#main-key` / owner = actorIRI /
 *     PublicKeyPem = the stored SPKI PEM. `@context` is the jsonld pair the
 *     deleted marshal pinned: the ActivityStreams base + the security
 *     vocabulary (`jsonld.WithContext(IRI(ActivityBaseURI),
 *     IRI(SecurityContextURI))`, client.go's ActivityStreamsContentType).
 *
 * Rendering divergence (recorded in SPEC §6.2 as-built): upstream marshalled
 * through go-ap/jsonld, whose NaturalLanguageValues render as lang maps;
 * those dependencies died with #36789 and are unrecoverable, so Name/
 * PreferredUsername render as plain strings — the form every ActivityPub
 * consumer keys on, and equivalent under the deleted integration test's
 * round-trip assertions (which pinned values, never rendering).
 *
 * The lookup arm is `GetUserByID` through `UserIDAssignmentAPI`
 * (user.go at `1592576fa5^`:34-52) — type-blind (org rows serve Person
 * documents too, upstream-faithful), NO visibility gate (the ID variant
 * carries none; the private actor doc is upstream behavior), garbage or
 * overflow ids collapse to 0 (Go `PathParamInt64` ignores the ParseInt
 * error) and 404 as `user does not exist [uid: 0, name: ]`.
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users, userSettingsKv } from "../../db/schema";
import { pemEncode } from "./httpsig";
import type { FederationUserRow } from "./webfinger";

/** Upstream's deleted setting keys (`UserActivityPubPrivPem` /
 *  `UserActivityPubPubPem`, models/user/setting_options.go pre-#36789) —
 *  same semantics, OUR names (SPEC §4.2). Lowercase: the kv store's
 *  validateUserSettingKey posture (schema.ts). */
export const ACTIVITYPUB_SETTING_KEY_PRIVATE = "activitypub.priv_pem";
export const ACTIVITYPUB_SETTING_KEY_PUBLIC = "activitypub.pub_pem";

/** Upstream `rsaBits` (modules/activitypub/user_settings.go:14). Note the
 *  distro keys' 2048 was a documented Workers-cost divergence; upstream's
 *  ActivityPub figure IS 3072 and the SPEC §4.2 commits to it. */
const RSA_BITS = 3072;

/**
 * Go `strconv.ParseInt(text, 10, 64)` with the error ignored — upstream
 * `PathParamInt64` (services/context/base.go): parse failure leaves 0, and
 * an out-of-int64 literal is a parse error too. Optional sign, digits only.
 */
export function parseActorIdParam(text: string | undefined): number {
  if (text === undefined || !/^[+-]?[0-9]+$/.test(text)) return 0;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * `GetUserByID` (user.go:1110-1118) — plain id read, any user type (the
 * UserIDAssignmentAPI variant has no type filter and no visibility gate).
 */
export async function findActorUserById(d1: D1Database, id: number): Promise<FederationUserRow | undefined> {
  return drizzle(d1).select().from(users).where(eq(users.id, id)).get();
}

async function readKvSetting(d1: D1Database, userId: number, key: string): Promise<string | null> {
  const row = await drizzle(d1)
    .select({ settingValue: userSettingsKv.settingValue })
    .from(userSettingsKv)
    .where(and(eq(userSettingsKv.userId, userId), eq(userSettingsKv.settingKey, key)))
    .get();
  return row?.settingValue ?? null;
}

export interface ActorKeyPairPems {
  privatePem: string;
  publicPem: string;
}

/** WebCrypto RSA-3072 → the PEM pair: PKCS#8 private / SPKI public — the
 *  wire arm only ever parses the PUBLIC half, whose SPKI form is what the
 *  deleted `GetPublicKey` served and what remote verifiers import. */
async function generateActorKeyPair(): Promise<ActorKeyPairPems> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: RSA_BITS, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair) || !("publicKey" in pair)) {
    throw new Error("activitypub key generation did not yield a pair");
  }
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  if (!(pkcs8 instanceof ArrayBuffer) || !(spki instanceof ArrayBuffer)) {
    throw new Error("unexpected activitypub key export form");
  }
  return {
    privatePem: pemEncode("PRIVATE KEY", new Uint8Array(pkcs8)),
    publicPem: pemEncode("PUBLIC KEY", new Uint8Array(spki)),
  };
}

/**
 * Upstream `GetKeyPair`/`GetPublicKey` (user_settings.go:18-47): read both
 * rows; absent → generate, store, RE-READ — a concurrent generation may have
 * won the upsert race and the stored pair is authoritative either way (the
 * debian.ts `getOrCreateOwnerKeyPair` posture verbatim). Returns the PUBLIC
 * PEM — the only half the actor document serves.
 */
export async function getOrCreateActorPublicKey(d1: D1Database, userId: number): Promise<string> {
  let publicPem = await readKvSetting(d1, userId, ACTIVITYPUB_SETTING_KEY_PUBLIC);
  const privatePem = await readKvSetting(d1, userId, ACTIVITYPUB_SETTING_KEY_PRIVATE);
  if (publicPem === null || privatePem === null) {
    const generated = await generateActorKeyPair();
    await drizzle(d1)
      .insert(userSettingsKv)
      .values([
        { userId, settingKey: ACTIVITYPUB_SETTING_KEY_PRIVATE, settingValue: generated.privatePem },
        { userId, settingKey: ACTIVITYPUB_SETTING_KEY_PUBLIC, settingValue: generated.publicPem },
      ])
      .onConflictDoUpdate({
        target: [userSettingsKv.userId, userSettingsKv.settingKey],
        set: { settingValue: sql`excluded.setting_value` },
      })
      .run();
    // Re-read: the stored pair is authoritative even if a concurrent
    // generate won the race (debian.ts:564-570).
    publicPem = await readKvSetting(d1, userId, ACTIVITYPUB_SETTING_KEY_PUBLIC);
    if (publicPem === null) throw new Error("activitypub key pair vanished after upsert");
  }
  return publicPem;
}

/**
 * The Person document (person.go:20-79 at `1592576fa5^`) — field order
 * follows the deleted handler's assignment order (id/type from the go-ap
 * constructor, then Name, PreferredUsername, URL, Icon, Inbox, Outbox,
 * PublicKey), `@context` first (the jsonld marshal's context pair).
 */
export function buildPersonDocument(opts: {
  user: FederationUserRow;
  appUrl: string;
  publicKeyPem: string;
}): Record<string, unknown> {
  const link = `${opts.appUrl}api/v1/activitypub/user-id/${opts.user.id}`;
  return {
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id: link,
    type: "Person",
    name: opts.user.fullName ?? "",
    preferredUsername: opts.user.username,
    url: `${opts.appUrl}${opts.user.username}`,
    icon: {
      type: "Image",
      mediaType: "image/png",
      url: `${opts.appUrl}avatars/${opts.user.usernameLower}`,
    },
    inbox: `${link}/inbox`,
    outbox: `${link}/outbox`,
    publicKey: {
      id: `${link}#main-key`,
      owner: link,
      publicKeyPem: opts.publicKeyPem,
    },
  };
}

/**
 * The route-facing assembly: lookup + keypair + document (the thin-routes
 * rule — the handler only maps the outcome onto HTTP bytes).
 */
export async function resolvePersonDocument(
  d1: D1Database,
  userId: number,
  opts: { appUrl: string },
): Promise<{ user: FederationUserRow; person: Record<string, unknown> } | undefined> {
  const user = await findActorUserById(d1, userId);
  if (user === undefined) return undefined;
  const publicKeyPem = await getOrCreateActorPublicKey(d1, user.id);
  return { user, person: buildPersonDocument({ user, appUrl: opts.appUrl, publicKeyPem }) };
}
