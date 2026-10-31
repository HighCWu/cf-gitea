/**
 * Webfinger resolution (SPEC specs/federation.md Tier A, W-A1) — the port of
 * upstream `WebfingerQuery` (gitea/routers/web/webfinger.go:38-122 at pin
 * fc493688) split per the thin-routes rule: this module owns the resource
 * parse, the user lookups, the visibility gate and the JRD projection; the
 * route (api/routes/federation.ts) only maps the outcome onto HTTP bytes.
 *
 * The pin's surface is COMPLETE webfinger (upstream shipped it and retracted
 * only the ActivityPub data plane behind it — commit 1592576fa5, PR #36789):
 *
 *   - `resource=acct:user@host` — same-instance only: the host part must
 *     string-equal the AppURL host or 400 (webfinger.go:57-60; no
 *     remote-actor proxying exists). Resolution = `GetUserByName`
 *     (webfinger.go:62) — ANY user type: org rows resolve too
 *     (models/user/user.go:1120-1135 has no type filter), so a JRD for an
 *     org is upstream behavior, ported type-blind.
 *   - `resource=mailto:...` — `GetUserByEmail` (user.go:1372-1402),
 *     suppressed to not-exist when the resolved user keeps email private
 *     (webfinger.go:63-67 — the OQ-6 port-faithful default). Our
 *     `GetUserByEmail` port unions the SPEC-0002 §3 synthesized primary
 *     (`users.email`) with the activated `email_addresses` rows, then keeps
 *     upstream's `NO_REPLY_ADDRESS` arm: `<name>@noreply.<domain>` /
 *     `<id>+<name>@noreply.<domain>` resolve by name (individual rows only,
 *     GetIndividualUserByName) or id. The domain is the REQUEST hostname —
 *     the house noreply emission convention (`<login>@noreply.<hostname>`,
 *     api/routes/contents.ts:260) standing in for upstream's
 *     `noreply. + Service.Domain` default (modules/setting/service.go:212).
 *   - Any other scheme (or an unparseable resource): 400 (webfinger.go:68-70).
 *   - Visibility: `IsUserVisibleToViewer` → 404 when hidden
 *     (webfinger.go:82-85) — the landed predicate (api/services/user.ts).
 *   - JRD (webfinger.go:87-121): subject `acct:{QueryEscape(name)}@{host}`,
 *     aliases HTMLURL + the actor IRI (+ `mailto:` unless private), links =
 *     profile-page / avatar / self (`application/activity+json` → the actor
 *     IRI that 501s at the pin) / openid-connect issuer. Field order here is
 *     Go struct-declaration order — the byte-shape the SPEC pins.
 *
 * Divergences (each recorded in specs/federation.md §6.1 as-built marks):
 *   - AppURL: upstream reads `setting.AppURL` (trailing slash guaranteed,
 *     server.go:50-51); ours is the appOrigin chain — the optional APP_URL
 *     var, else the request origin — normalized to the trailing-slash form
 *     (services/webhooks-push.ts posture).
 *   - Avatar link: upstream `u.AvatarLink` is gravatar/federated-config
 *     dependent (models/user/avatar.go:83-86 → models/avatars/avatar.go:
 *     116-140); ours is the canonical house projection
 *     `{appUrl}avatars/{usernameLower}` (api/services/repository.ts:495 —
 *     the URL every user serialization already carries), served by the
 *     avatar-serving seam.
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { emailAddresses, users } from "../../db/schema";
import { loadUserSettings } from "../../api/services/user-settings";
import {
  isUserVisibleToViewer,
  type UserVisibilityDoer,
} from "../../api/services/user";

/** D1 row of the `users` table — the resolution target. */
export type FederationUserRow = typeof users.$inferSelect;

// ---------------------------------------------------------------------------
// AppURL
// ---------------------------------------------------------------------------

/**
 * Upstream `setting.AppURL` equivalent — the discovery tier's URL base, in
 * the appOrigin chain: the optional `APP_URL` var (the configured instance
 * origin, webhooks-push.ts posture), else the serving request's origin.
 * Upstream guarantees the trailing "/" (server.go:50-51) and every emit
 * below concatenates onto it (`AppURL + "api/v1/..."`), so the slash is
 * normalized here once.
 */
export function federationAppUrl(envAppUrl: string | undefined, requestOrigin: string): string {
  const raw = envAppUrl === undefined || envAppUrl.trim() === "" ? requestOrigin : envAppUrl.trim();
  return `${raw.replace(/\/+$/, "")}/`;
}

// ---------------------------------------------------------------------------
// The resource parse — Go url.Parse's scheme/opaque extraction
// ---------------------------------------------------------------------------

/**
 * `url.Parse(ctx.FormTrim("resource"))` (webfinger.go:41-45) reduced to the
 * two fields the switch reads: `Scheme` and `Opaque`. Go's getScheme walks
 * `[A-Za-z][A-Za-z0-9+.-]*` up to the first `:`; any other character before
 * the colon means "no valid scheme" (the whole string stays in Path, Scheme
 * is "") — and the switch's default arm then 400s (webfinger.go:68-70).
 * Go PARSE ERRORS (ASCII control characters, invalid percent-escapes) also
 * land on 400 via webfinger.go:42-45's explicit arm; both shapes collapse to
 * the same `scheme: ""` result here, which the outcome ladder maps to the
 * same 400 — the observable surface is byte-identical. An authority form
 * (`acct://...`) leaves Opaque empty in Go (the authority is consumed), so
 * the `//` prefix strips to "".
 */
export function parseResource(raw: string): { scheme: string; opaque: string } {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):([\s\S]*)$/.exec(raw);
  if (match === null) return { scheme: "", opaque: "" };
  // Go url.Parse rejects ASCII control characters and invalid % escapes —
  // both are parse errors → the 400 arm; "no scheme" gives the same 400.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return { scheme: "", opaque: "" };
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) return { scheme: "", opaque: "" };
  let opaque = match[2] ?? "";
  if (opaque.startsWith("//")) opaque = "";
  return { scheme: (match[1] ?? "").toLowerCase(), opaque };
}

// ---------------------------------------------------------------------------
// The lookups — GetUserByName / GetUserByEmail (models/user)
// ---------------------------------------------------------------------------

/**
 * `GetUserByName` (user.go:1120-1135): `lower_name = ?`, ANY user type —
 * webfinger resolves org rows as well as users. Uniqueness of
 * `users_username_lower_uq` makes the single-row get exact.
 */
async function findUserByName(d1: D1Database, name: string): Promise<FederationUserRow | undefined> {
  return drizzle(d1).select().from(users).where(eq(users.usernameLower, name.toLowerCase())).get();
}

/** `GetIndividualUserByName` (user.go:1125-1127): the type='user' filter on
 *  top of the same lower-name read — the noreply name arm's resolver. */
async function findIndividualUserByName(
  d1: D1Database,
  name: string,
): Promise<FederationUserRow | undefined> {
  return drizzle(d1)
    .select()
    .from(users)
    .where(and(eq(users.usernameLower, name.toLowerCase()), eq(users.type, "user")))
    .get();
}

/** `GetUserByID` (user.go:1110-1118): plain id read, any type. */
async function findUserById(d1: D1Database, id: number): Promise<FederationUserRow | undefined> {
  return drizzle(d1).select().from(users).where(eq(users.id, id)).get();
}

/** Go strconv.ParseInt(localPart, 10, 64) — optional sign, digits only. */
function parseGoInt64(text: string): number {
  if (!/^[+-]?[0-9]+$/.test(text)) return 0;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * `GetUserByEmail` (user.go:1372-1402): lower-case, then the activated
 * `email_address` row (upstream `lower_email = ? AND is_activated = true`),
 * then the protected-address arm. cf-gitea keeps the primary address on
 * `users.email` (SPEC-0002 §3 — the email_addresses table holds secondaries
 * only; routes/misc-t3.ts unions the primary back), so the primary lookup
 * rides the same lowered compare before the noreply arm. The noreply suffix
 * is `@noreply.` + the request hostname (the module header's domain note).
 */
async function findUserByEmail(
  d1: D1Database,
  email: string,
  noreplyDomain: string,
): Promise<FederationUserRow | undefined> {
  if (email === "") return undefined;
  email = email.toLowerCase();

  const secondary = await drizzle(d1)
    .select({ userId: emailAddresses.userId })
    .from(emailAddresses)
    .where(and(eq(emailAddresses.lowerEmail, email), eq(emailAddresses.isActivated, true)))
    .get();
  if (secondary !== undefined) {
    return findUserById(d1, secondary.userId);
  }

  const primary = await drizzle(d1)
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .get();
  if (primary !== undefined) {
    return primary;
  }

  const suffix = `@noreply.${noreplyDomain.toLowerCase()}`;
  if (!email.endsWith(suffix)) return undefined;
  const localPart = email.slice(0, email.length - suffix.length);
  const plus = localPart.indexOf("+");
  if (plus < 0) {
    // "<name>@noreply.<domain>" → GetIndividualUserByName (user.go:1395).
    return findIndividualUserByName(d1, localPart);
  }
  // "<id>+<name>@noreply.<domain>" → id non-zero wins, else the name arm
  // (parseLocalPartToNameID, user.go:1349-1363: ParseInt errors leave id 0).
  const id = parseGoInt64(localPart.slice(0, plus));
  if (id !== 0) {
    return findUserById(d1, id);
  }
  return findIndividualUserByName(d1, localPart.slice(plus + 1));
}

/** Upstream `u.KeepEmailPrivate` — the user_settings side store's hideEmail
 *  (schema.ts; loadUserSettings renders the default false for absent rows,
 *  upstream's creation value). */
async function keepsEmailPrivate(d1: D1Database, user: FederationUserRow): Promise<boolean> {
  return (await loadUserSettings(d1, user.id)).hideEmail;
}

// ---------------------------------------------------------------------------
// The JRD projection — webfinger.go:87-121
// ---------------------------------------------------------------------------

/**
 * Go `url.QueryEscape`: `[A-Za-z0-9-_.~]` pass, space becomes "+", the rest
 * percent-escape with uppercase hex. Used only for the subject's username —
 * Go's fmt.Sprintf("acct:%s@%s", url.QueryEscape(u.Name), appURL.Host),
 * webfinger.go:118.
 */
function queryEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch;
    } else if (ch === " ") {
      out += "+";
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * The webfingerJRD — field order is Go struct order (Subject, Aliases,
 * Links; Properties always omitted), link fields Rel/Type/Href with the
 * omitempty gaps exactly as webfingerLink declares them. `self` advertises
 * the actor IRI `{appUrl}api/v1/activitypub/user-id/{id}` — at the pin that
 * URL answers 501 (the registered-but-unimplemented stub); upstream's own
 * discovery advertises a door that is not built, and so does ours.
 */
export function buildWebfingerJrd(
  user: FederationUserRow,
  opts: { appUrl: string; host: string; hideEmail: boolean },
): Record<string, unknown> {
  const htmlUrl = `${opts.appUrl}${user.username}`;
  const actorIri = `${opts.appUrl}api/v1/activitypub/user-id/${user.id}`;

  const aliases: string[] = [htmlUrl, actorIri];
  if (!opts.hideEmail) {
    aliases.push(`mailto:${user.email ?? ""}`);
  }

  return {
    subject: `acct:${queryEscape(user.username)}@${opts.host}`,
    aliases,
    links: [
      {
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: htmlUrl,
      },
      {
        rel: "http://webfinger.net/rel/avatar",
        href: `${opts.appUrl}avatars/${user.usernameLower}`,
      },
      {
        rel: "self",
        type: "application/activity+json",
        href: actorIri,
      },
      {
        rel: "http://openid.net/specs/connect/1.0/issuer",
        href: opts.appUrl,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The outcome ladder — WebfingerQuery's arms in upstream order
// ---------------------------------------------------------------------------

export type WebfingerOutcome =
  | { kind: "bad-request" }
  | { kind: "not-found" }
  | { kind: "found"; user: FederationUserRow; jrd: Record<string, unknown> };

/**
 * The webfinger.go:38-122 ladder: parse → scheme switch (acct same-host /
 * mailto with the private-email suppression / default 400) → not-exist 404 →
 * visibility 404 → JRD. `viewer` is the web session principal
 * (`ctx.Doer`) — the route resolves it through resolveViewer; `host` is the
 * AppURL host (webfinger.go:57's `appURL.Host` compare and :118's subject
 * suffix); `noreplyDomain` is the request hostname for the GetUserByEmail
 * noreply arm.
 */
export async function resolveWebfinger(
  d1: D1Database,
  resourceValue: string,
  viewer: UserVisibilityDoer,
  opts: { appUrl: string; host: string; noreplyDomain: string },
): Promise<WebfingerOutcome> {
  const { scheme, opaque } = parseResource(resourceValue);

  let user: FederationUserRow | undefined;
  switch (scheme) {
    case "acct": {
      // strings.SplitN(resource.Opaque, "@", 2) — exactly two parts; the
      // host part must string-equal the AppURL host (webfinger.go:52-60).
      const at = opaque.indexOf("@");
      if (at < 0) return { kind: "bad-request" };
      if (opaque.slice(at + 1) !== opts.host) return { kind: "bad-request" };
      user = await findUserByName(d1, opaque.slice(0, at));
      break;
    }
    case "mailto": {
      user = await findUserByEmail(d1, opaque, opts.noreplyDomain);
      // The private-email suppression (webfinger.go:65-67): a mailto hit on
      // a user who hides their email reads as not-exist.
      if (user !== undefined && (await keepsEmailPrivate(d1, user))) {
        return { kind: "not-found" };
      }
      break;
    }
    default:
      return { kind: "bad-request" };
  }

  if (user === undefined) return { kind: "not-found" };

  // IsUserVisibleToViewer → 404 when hidden (webfinger.go:82-85).
  if (!(await isUserVisibleToViewer(d1, user, viewer))) {
    return { kind: "not-found" };
  }

  const hideEmail = await keepsEmailPrivate(d1, user);
  return {
    kind: "found",
    user,
    jrd: buildWebfingerJrd(user, { appUrl: opts.appUrl, host: opts.host, hideEmail }),
  };
}
