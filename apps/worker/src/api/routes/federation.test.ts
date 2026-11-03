/**
 * Federation suite (specs/federation.md §6.1 / §6.2 / §7): Tier A — the
 * discovery pair on real D1 — plus Tier B as-built (W-B2/W-B3/W-B4, the
 * 2026-11-01 completion directive): the Person actor, the signature-
 * verified inbox with the Follow→Accept ladder, the keypair store, and the
 * chi-exact method tree — with the S-1 follower store on top (migration
 * 0063, the ADR-0007 grant: the signer-bound Follow persists, the Undo
 * removes, the re-Follow is a no-op, the user-delete cascade drops the
 * rows; every valid-path response byte stays the pre-S-1 as-built's). Both
 * routers driven
 * standalone (the HANDOFF mounts in src/index.ts + api/router.ts are the
 * orchestrator's; the sub-apps are mounted verbatim, so these pins carry
 * over unchanged).
 *
 * Arms pinned, each with its upstream cite:
 *   - the FEDERATION_ENABLED gate: strict "true" polarity; disabled web
 *     pair answers Go ctx.HTTPError(404)'s plain `Not Found\n`
 *     (services/context/base.go:105-111, wrapped by web.go:409-414);
 *     disabled API arms answer the router's native 404 — upstream's
 *     registration conditional (api.go:1007) leaves them unregistered;
 *   - GET /.well-known/nodeinfo: the single link, byte-shaped per
 *     nodeinfo.go:23-31 (Go compact struct marshal, href before rel);
 *   - GET /.well-known/webfinger: the complete webfinger.go:38-122 ladder —
 *     same-host acct (foreign host / no-@ / unknown scheme / missing → 400
 *     `Bad Request\n`), mailto with the private-email suppression (the OQ-6
 *     port-faithful arm), the visibility gate (anonymous vs. the session
 *     doer), the noreply arm of GetUserByEmail (user.go:1372-1402), the
 *     type-blind org resolution (GetUserByName has no type filter),
 *     unknown-user 404, and the JRD byte-shape (webfinger.go:87-121:
 *     subject/aliases/links in Go struct order, the in-handler
 *     `Access-Control-Allow-Origin: *` stamp at :116);
 *   - the API arms: /api/v1/nodeinfo keeps the W-B1 501 stub
 *     (person.go:12-14's Go http.Error line; that wave was not in this
 *     dispatch's scope); the activitypub family is the PRE-STUB
 *     registration shape (`1592576fa5^`, SPEC §6.2) —
 *     GET /activitypub/user-id/{id} → the Person actor (person.go:20-79),
 *     POST /activitypub/user-id/{id}/inbox → ReqHTTPSignature + PersonInbox
 *     (reqsignature.go; the Follow→Accept ladder is the user directive's
 *     arm now durable through the S-1 store — the signer-bound Follow
 *     persists into federation_followers and the Undo removes, everything
 *     else the 204 black hole), every other /activitypub/*
 *     path UNREGISTERED → the router's native 404 (incl. the deprecated
 *     /user/{username} form, api.go's own "remove in 1.20" note). The
 *     inline activitypub scope gate: anonymous passes (api.go:281-283), a
 *     foreign-category token 403s with api.go:300's body;
 *   - the method arms (the 7538a40 adjudication, chi-exact): armed paths
 *     405 with `Allow:` for every known non-registered method BEFORE any
 *     middleware (chi's methodNotAllowedHandler — the scope gate never runs
 *     for an unresolved method), disabled paths 404 natively for every
 *     known method (unregistered at api.go:1007), an unknown method
 *     bare-405s pre-tree (mux.go routeHTTP's early arm);
 *   - Tier B units (SPEC §7): the RSA-3072 keypair lazily generated into
 *     user_settings_kv (stable across serves — the debian.ts race posture),
 *     the verifier's error/rejected arms mapped onto house 500 / the exact
 *     403 body, the remote actor fetched through the injected fetchImpl
 *     seam (fixed vectors live in httpsig.test.ts).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { emailAddresses, userSettings, users } from "../../db/schema";
import type { AuthInfo, AuthUser } from "../../auth/auth-context";
import { ScopeSet } from "../../auth/scopes";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import {
  chiMethodNotAllowed,
  federationEnabled,
  registerFederationApiRoutes,
  wellKnownRouter,
  type FederationEnv,
} from "./federation";
import {
  federationAppUrl,
  parseResource,
  resolveWebfinger,
} from "../../services/federation/webfinger";
import { getOrCreateActorPublicKey } from "../../services/federation/activitypub";
import {
  ACTIVITY_STREAMS_CONTENT_TYPE,
  buildSigningString,
  computeSha256Digest,
  pemEncode,
  renderSignatureHeader,
  signSigningString,
} from "../../services/federation/httpsig";

const ORIGIN = "https://fed.example";
const HOST = "fed.example";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM email_addresses").run();
  await env.DB.prepare("DELETE FROM user_settings").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  // The S-1 store wipes via the users cascade too — the explicit run keeps
  // the suite independent of FK ordering.
  await env.DB.prepare("DELETE FROM federation_followers").run();
  await env.DB.prepare("DELETE FROM users").run();
});

/** The family env: the test bindings with the gate var injected. */
const familyEnv = (federation?: string, appUrl?: string): FederationEnv => ({
  ...env,
  FEDERATION_ENABLED: federation,
  APP_URL: appUrl,
});

/** The /.well-known sub-app, driven like the production "/" mount. */
const wellKnown = async (path: string, federation?: string, appUrl?: string): Promise<Response> =>
  await wellKnownRouter.request(`${ORIGIN}${path}`, {}, familyEnv(federation, appUrl));

/** The /api/v1 router with the federation family registered — exactly the
 *  production registration over OpenAPIHono<ApiEnv>. The auth middleware is
 *  the test's injectable stand-in for the production resolveAuth (it only
 *  has to put an AuthInfo in Variables.auth). The gate var rides the env
 *  through Object.assign — the generated Env does not carry
 *  FEDERATION_ENABLED until the operator's config gains it, and the assign
 *  builds the widened slice without a cast (the vitest env itself already
 *  carries non-config bindings the same way). `fetchImpl` and `appUrl` are
 *  the Tier B seams: the verifier's outbound actor fetch (SPEC §7's
 *  env-boundary stubbing) and the AppURL chain override. */
async function api(
  path: string,
  init?: RequestInit,
  opts?: { federation?: string; auth?: AuthInfo; fetchImpl?: typeof fetch; appUrl?: string },
): Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  if (opts?.auth !== undefined) {
    const auth = opts.auth;
    app.use("*", async (c, next) => {
      c.set("auth", auth);
      await next();
    });
  }
  registerFederationApiRoutes(app, { fetchImpl: opts?.fetchImpl });
  const envSlice = Object.assign({}, env, { FEDERATION_ENABLED: opts?.federation, APP_URL: opts?.appUrl });
  // The standalone app registers router-relative paths (no /api/v1 mount) —
  // the prefix strips off, the blocks.test.ts pattern.
  return await app.fetch(new Request(`${ORIGIN}${path}`, init), envSlice);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeedOptions {
  username: string;
  email?: string | null;
  fullName?: string | null;
  visibility?: "public" | "limited" | "private";
  type?: "user" | "org";
  hideEmail?: boolean;
}

/** A users row (+ the optional hideEmail side-store row) — the per-test
 *  world; tables are wiped in beforeEach so ids restart predictably enough
 *  to re-read. */
async function seedUser(options: SeedOptions): Promise<{ id: number; username: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username: options.username,
      usernameLower: options.username.toLowerCase(),
      email: options.email ?? null,
      ...(options.fullName === undefined ? {} : { fullName: options.fullName }),
      visibility: options.visibility ?? "public",
      type: options.type ?? "user",
      createdAt: new Date(),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  if (options.hideEmail === true) {
    await drizzle(env.DB).insert(userSettings).values({ userId: row.id, hideEmail: true });
  }
  return { id: row.id, username: row.username };
}

async function seedEmail(userId: number, email: string, activated: boolean): Promise<void> {
  await drizzle(env.DB)
    .insert(emailAddresses)
    .values({ userId, email, lowerEmail: email.toLowerCase(), isActivated: activated, isPrimary: false });
}

/** A fake AuthInfo carrying just the scope the gate reads (the route-level
 *  tests never touch the user fields). */
const authWithScope = (scopes: string): AuthInfo => {
  const user: AuthUser = {
    id: 1,
    username: "tester",
    usernameLower: "tester",
    email: null,
    displayName: null,
    location: null,
    website: null,
    description: null,
    isAdmin: false,
    status: "active",
    createdAt: new Date(),
  };
  return {
    user,
    token: {
      id: 1,
      userId: 1,
      name: "suite",
      prefix: "cfg_abcdef12",
      scopes,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
    },
    scope: ScopeSet.parse(scopes),
    isBasicAuth: true,
  };
};

/** Upstream api.go:300's exact 403 body (Go %v slice rendering). */
const scopeForbidden = (required: string, tokenScope: string): Record<string, string> => ({
  message: `token does not have at least one of required scope(s), required=[${required}], token scope=${tokenScope}`,
  url: `${ORIGIN}/api/swagger`,
});

// ---------------------------------------------------------------------------
// Tier B fixtures — the remote actor (SPEC §7's fetch-stubbed actors)
// ---------------------------------------------------------------------------

let remotePair: CryptoKeyPair;
let foreignPair: CryptoKeyPair;
let remotePem: string;
let malloryPem: string;
const REMOTE_KEY_ID = "https://remote.example/actors/bob#main-key";
const REMOTE_ACTOR_IRI = "https://remote.example/actors/bob";
// The second signer's identity — a fully-verified remote actor (her own
// keypair, keyId, and actor document) the signature gate PASSES; the
// signer-binding battery below pins that the activity's actor field still
// cannot borrow another actor's identity through her valid signature.
const MALLORY_KEY_ID = "https://remote.example/actors/mallory#main-key";
const MALLORY_ACTOR_IRI = "https://remote.example/actors/mallory";

async function generateRsa3072Pair(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair) || !("publicKey" in pair)) throw new Error("key generation did not yield a pair");
  return pair;
}

/** The fixture remote actor document the verifier's fetch returns. */
function remoteActorDoc(keyId: string, publicKeyPem: string): string {
  const owner = keyId.split("#")[0] ?? keyId;
  return JSON.stringify({
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id: owner,
    type: "Person",
    publicKey: { id: keyId, owner, publicKeyPem },
  });
}

beforeAll(async () => {
  remotePair = await generateRsa3072Pair();
  foreignPair = await generateRsa3072Pair();
  const spki = await crypto.subtle.exportKey("spki", remotePair.publicKey);
  if (!(spki instanceof ArrayBuffer)) throw new Error("unexpected key export form");
  remotePem = pemEncode("PUBLIC KEY", new Uint8Array(spki));
  const mallorySpki = await crypto.subtle.exportKey("spki", foreignPair.publicKey);
  if (!(mallorySpki instanceof ArrayBuffer)) throw new Error("unexpected key export form");
  malloryPem = pemEncode("PUBLIC KEY", new Uint8Array(mallorySpki));
});

/**
 * A signed inbox POST (the deleted client.go's signing posture —
 * `(request-target) date digest`, rsa-sha256, the remote actor's #main-key
 * keyId) dispatched through the api() helper with the fetch stub serving
 * the fixture actor document. `digest` computes over the actual body unless
 * overridden; `date` defaults to fresh-now (the 60 s TTL is real here).
 */
async function signedInbox(
  path: string,
  body: string,
  opts: {
    auth?: AuthInfo;
    keyPair?: CryptoKeyPair;
    keyId?: string;
    date?: string;
    omitDateHeader?: boolean;
    digest?: string | null;
    algorithm?: string;
    signature?: string;
    /** The publicKeyPem the served actor document carries — defaults to
     *  bob's (remotePem); mallory's requests pass her own (malloryPem) so
     *  her signature verifies against her document. */
    pem?: string;
    docBody?: string;
    docStatus?: number;
    fetchError?: boolean;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Response> {
  const url = new URL(`${ORIGIN}${path}`);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const headers: Record<string, string> = { "content-type": ACTIVITY_STREAMS_CONTENT_TYPE };
  if (opts.omitDateHeader !== true) headers["date"] = opts.date ?? new Date().toUTCString();
  const bodyBytes = new TextEncoder().encode(body);
  if (opts.digest !== null) {
    headers["digest"] = opts.digest ?? (await computeSha256Digest(bodyBytes));
  }
  const signingString = buildSigningString(
    { method: "POST", pathWithQuery, header: (name) => headers[name.toLowerCase()] },
    ["(request-target)", "date", "digest"],
  );
  if (signingString === null) throw new Error("fixture signing string failed");
  const signature =
    opts.signature ?? (await signSigningString(signingString, (opts.keyPair ?? remotePair).privateKey));
  headers["signature"] = renderSignatureHeader({
    keyId: opts.keyId ?? REMOTE_KEY_ID,
    algorithm: opts.algorithm ?? "rsa-sha256",
    headers: ["(request-target)", "date", "digest"],
    signature,
  });
  const keyId = opts.keyId ?? REMOTE_KEY_ID;
  const doc = opts.docBody ?? remoteActorDoc(keyId, opts.pem ?? remotePem);
  const fetchImpl: typeof fetch = opts.fetchImpl ??
    (opts.fetchError
      ? () => Promise.reject(new Error("network down"))
      : () => Promise.resolve(new Response(doc, { status: opts.docStatus ?? 200 })));
  return api(path, { method: "POST", body, headers }, { federation: "true", auth: opts.auth, fetchImpl });
}

/** Mallory — a second fully-verified remote signer: her key signs, her keyId
 *  fetches, her document's publicKey.id matches, the verifier answers
 *  `verified` with HER IRI. The signer-binding battery drives her against
 *  bodies that claim other actors' identities. */
function malloryInbox(path: string, body: string): Promise<Response> {
  return signedInbox(path, body, { keyPair: foreignPair, keyId: MALLORY_KEY_ID, pem: malloryPem });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("the FEDERATION_ENABLED gate (federation.go:23, default false)", () => {
  it("arms ONLY on the exact string true — the strict-polarity class", () => {
    const probe = (raw: string | undefined): boolean => federationEnabled({ ...env, FEDERATION_ENABLED: raw });
    expect(probe(undefined)).toBe(false);
    expect(probe("")).toBe(false);
    expect(probe("false")).toBe(false);
    expect(probe("False")).toBe(false);
    expect(probe("true ")).toBe(false);
    expect(probe("1")).toBe(false);
    expect(probe("true")).toBe(true);
  });

  it("parses the resource like Go url.Parse's scheme/opaque split", () => {
    expect(parseResource("acct:alice@example.com")).toEqual({ scheme: "acct", opaque: "alice@example.com" });
    expect(parseResource("ACCT:alice@example.com")).toEqual({ scheme: "acct", opaque: "alice@example.com" });
    expect(parseResource("mailto:Alice@Example.com")).toEqual({ scheme: "mailto", opaque: "Alice@Example.com" });
    // No colon, invalid scheme start, or a bad character before the colon:
    // Go leaves Scheme "" → the switch's default arm 400s.
    expect(parseResource("alice@example.com")).toEqual({ scheme: "", opaque: "" });
    expect(parseResource("")).toEqual({ scheme: "", opaque: "" });
    expect(parseResource("1acct:x")).toEqual({ scheme: "", opaque: "" });
    expect(parseResource("acct x:y")).toEqual({ scheme: "", opaque: "" });
    // Parse errors (control chars, invalid % escape) land on 400 upstream.
    expect(parseResource("acct:ali%zzx")).toEqual({ scheme: "", opaque: "" });
    expect(parseResource("acct:ali\tex")).toEqual({ scheme: "", opaque: "" });
    // The authority form consumes the net-path: Opaque stays empty.
    expect(parseResource("acct://alice@example.com")).toEqual({ scheme: "acct", opaque: "" });
  });

  it("normalizes the AppURL chain to the trailing-slash form (server.go:50-51)", () => {
    expect(federationAppUrl(undefined, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(federationAppUrl("https://custom.example", ORIGIN)).toBe("https://custom.example/");
    expect(federationAppUrl("https://custom.example/", ORIGIN)).toBe("https://custom.example/");
    expect(federationAppUrl("  https://custom.example/  ", ORIGIN)).toBe("https://custom.example/");
    expect(federationAppUrl("", ORIGIN)).toBe(`${ORIGIN}/`);
  });
});

// ---------------------------------------------------------------------------
// /.well-known/nodeinfo — nodeinfo.go:23-31
// ---------------------------------------------------------------------------

describe("GET /.well-known/nodeinfo", () => {
  it("enabled: the single 2.1 link, byte-shaped (href before rel, compact)", async () => {
    const response = await wellKnown("/.well-known/nodeinfo", "true");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `{"links":[{"href":"${ORIGIN}/api/v1/nodeinfo","rel":"http://nodeinfo.diaspora.software/ns/schema/2.1"}]}`,
    );
  });

  it("enabled: the APP_URL var is the href base (the AppURL chain)", async () => {
    const response = await wellKnown("/.well-known/nodeinfo", "true", "https://custom.example");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      '{"links":[{"href":"https://custom.example/api/v1/nodeinfo","rel":"http://nodeinfo.diaspora.software/ns/schema/2.1"}]}',
    );
  });

  it("disabled: upstream's gate 404 — the plain `Not Found` http.Error line", async () => {
    for (const federation of [undefined, "false"]) {
      const response = await wellKnown("/.well-known/nodeinfo", federation);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found\n");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

// ---------------------------------------------------------------------------
// /.well-known/webfinger — webfinger.go:38-122
// ---------------------------------------------------------------------------

describe("GET /.well-known/webfinger — the gate and the 400 arms", () => {
  it("disabled: the same plain `Not Found` 404 the nodeinfo link gets", async () => {
    const response = await wellKnown("/.well-known/webfinger?resource=acct:alice@fed.example", "false");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found\n");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("400s: foreign host, missing @, unknown scheme, missing resource (webfinger.go:53-70)", async () => {
    await seedUser({ username: "alice", email: "alice@example.com" });
    for (const resource of [
      "acct:alice@elsewhere.example", // webfinger.go:57-60 — same-instance only
      "acct:alice", // SplitN finds no @ → 400 (:53-56)
      "acct://alice@fed.example", // the authority form leaves Opaque empty → no @
      "https://fed.example/alice", // :68-70 — any other scheme
      "mailto-no-at-thing", // no valid scheme → the default arm
    ]) {
      const response = await wellKnown(`/.well-known/webfinger?resource=${encodeURIComponent(resource)}`, "true");
      expect(response.status, resource).toBe(400);
      expect(await response.text(), resource).toBe("Bad Request\n");
      expect(response.headers.get("content-type"), resource).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-content-type-options"), resource).toBe("nosniff");
    }
    // The missing query param: FormTrim gives "" → Scheme "" → default → 400.
    const missing = await wellKnown("/.well-known/webfinger", "true");
    expect(missing.status).toBe(400);
    expect(await missing.text()).toBe("Bad Request\n");
  });

  it("404s an unknown user with the plain http.Error line (webfinger.go:72-75)", async () => {
    const response = await wellKnown(`/.well-known/webfinger?resource=acct:ghost@${HOST}`, "true");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found\n");
  });
});

describe("GET /.well-known/webfinger — the JRD (webfinger.go:87-121)", () => {
  it("acct same-host: the exact byte-shape — subject, aliases, four links, CORS *", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });

    const response = await wellKnown(`/.well-known/webfinger?resource=acct:alice@${HOST}`, "true");
    expect(response.status).toBe(200);
    // webfinger.go:116 — the in-handler stamp, gate-open only.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("content-type")).toContain("application/json");

    const actorIri = `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`;
    // Go struct-declaration order: Subject, Aliases, Links — one line, the
    // render the omitempty gaps leave exact.
    const body = await response.text();
    expect(body).toBe(
      JSON.stringify({
        subject: `acct:alice@${HOST}`,
        aliases: [`${ORIGIN}/alice`, actorIri, "mailto:alice@example.com"],
        links: [
          { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: `${ORIGIN}/alice` },
          { rel: "http://webfinger.net/rel/avatar", href: `${ORIGIN}/avatars/alice` },
          { rel: "self", type: "application/activity+json", href: actorIri },
          { rel: "http://openid.net/specs/connect/1.0/issuer", href: `${ORIGIN}/` },
        ],
      }),
    );

    // The self link advertises the actor IRI that 501s at the pin —
    // upstream's own posture (SPEC §2.2: the discovery points at a door
    // that is not built).
    const jrd = JSON.parse(body) as { links: Array<{ rel: string; href: string }> };
    expect(jrd.links.find((link) => link.rel === "self")?.href).toBe(actorIri);
  });

  it("resolution is case-insensitive, the subject keeps the row's display name", async () => {
    await seedUser({ username: "Alice", email: "Alice@Example.com" });
    // The host compare is exact (webfinger.go:57) — only the NAME part may
    // vary in case; the subject renders u.Name, not the queried spelling.
    const response = await wellKnown(`/.well-known/webfinger?resource=acct:${encodeURIComponent("ALICE")}@${HOST}`, "true");
    expect(response.status).toBe(200);
    const jrd = await response.json<{ subject: string }>();
    expect(jrd.subject).toBe(`acct:Alice@${HOST}`);
  });

  it("an org row resolves too — GetUserByName is type-blind (user.go:1120-1135)", async () => {
    const acme = await seedUser({ username: "acme", type: "org" });
    const response = await wellKnown(`/.well-known/webfinger?resource=acct:acme@${HOST}`, "true");
    expect(response.status).toBe(200);
    const jrd = await response.json<{ aliases: string[] }>();
    expect(jrd.aliases[0]).toBe(`${ORIGIN}/acme`);
    expect(jrd.aliases[1]).toBe(`${ORIGIN}/api/v1/activitypub/user-id/${acme.id}`);
    // The org row has no email; with the public default (!KeepEmailPrivate)
    // upstream's unconditional append still emits the degenerate `mailto:`
    // alias (webfinger.go:91-93) — kept faithful.
    expect(jrd.aliases).toEqual([`${ORIGIN}/acme`, `${ORIGIN}/api/v1/activitypub/user-id/${acme.id}`, "mailto:"]);
  });

  it("mailto: the primary address resolves (the SPEC-0002 §3 synthesized primary)", async () => {
    await seedUser({ username: "alice", email: "alice@example.com" });
    const response = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent("mailto:ALICE@EXAMPLE.COM")}`,
      "true",
    );
    expect(response.status).toBe(200);
    const jrd = await response.json<{ subject: string; aliases: string[] }>();
    expect(jrd.subject).toBe(`acct:alice@${HOST}`);
    expect(jrd.aliases).toContain("mailto:alice@example.com");
  });

  it("mailto: activated secondaries resolve, unactivated ones stay invisible (user.go:1381-1386)", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });
    await seedEmail(alice.id, "second@example.com", true);
    const activated = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent("mailto:second@example.com")}`,
      "true",
    );
    expect(activated.status).toBe(200);

    await seedEmail(alice.id, "third@example.com", false);
    const unactivated = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent("mailto:third@example.com")}`,
      "true",
    );
    expect(unactivated.status).toBe(404);
    expect(await unactivated.text()).toBe("Not Found\n");
  });

  it("mailto: the private-email suppression reads as not-exist (webfinger.go:65-67) and the alias disappears", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.com", hideEmail: true });
    const byMail = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent("mailto:bob@example.com")}`,
      "true",
    );
    expect(byMail.status).toBe(404);
    expect(await byMail.text()).toBe("Not Found\n");

    // The acct form still resolves — but the JRD omits the mailto alias.
    const byName = await wellKnown(`/.well-known/webfinger?resource=acct:bob@${HOST}`, "true");
    expect(byName.status).toBe(200);
    const jrd = await byName.json<{ aliases: string[] }>();
    expect(jrd.aliases).toEqual([
      `${ORIGIN}/bob`,
      `${ORIGIN}/api/v1/activitypub/user-id/${bob.id}`,
    ]);
  });

  it("mailto: the noreply arm of GetUserByEmail (user.go:1388-1394) — name and id+name forms", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });

    const byName = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent(`mailto:alice@noreply.${HOST}`)}`,
      "true",
    );
    expect(byName.status).toBe(200);
    const byId = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent(`mailto:${alice.id}+alice@noreply.${HOST}`)}`,
      "true",
    );
    expect(byId.status).toBe(200);

    // A noreply address naming nobody stays 404; the individual-only name arm
    // skips org rows (GetIndividualUserByName).
    const ghost = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent(`mailto:ghost@noreply.${HOST}`)}`,
      "true",
    );
    expect(ghost.status).toBe(404);
    await seedUser({ username: "acme", type: "org" });
    const orgByNoreply = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent(`mailto:acme@noreply.${HOST}`)}`,
      "true",
    );
    expect(orgByNoreply.status).toBe(404);
  });

  it("the visibility gate: private and limited users 404 the anonymous webfinger (webfinger.go:82-85)", async () => {
    await seedUser({ username: "carol", email: "carol@example.com", visibility: "private" });
    await seedUser({ username: "dave", email: "dave@example.com", visibility: "limited" });
    for (const name of ["carol", "dave"]) {
      const response = await wellKnown(`/.well-known/webfinger?resource=acct:${name}@${HOST}`, "true");
      expect(response.status, name).toBe(404);
      expect(await response.text(), name).toBe("Not Found\n");
    }
  });
});

describe("resolveWebfinger — the session-viewer arms (IsUserVisibleToViewer)", () => {
  it("a private user sees themself; an admin sees everyone; a limited user admits any signed-in doer", async () => {
    const carol = await seedUser({ username: "carol", email: "carol@example.com", visibility: "private" });
    await seedUser({ username: "dave", email: "dave@example.com", visibility: "limited" });

    const opts = { appUrl: `${ORIGIN}/`, host: HOST, noreplyDomain: HOST };

    const selfView = await resolveWebfinger(env.DB, `acct:carol@${HOST}`, { id: carol.id, isAdmin: false, loginLower: "carol" }, opts);
    expect(selfView.kind).toBe("found");

    const adminView = await resolveWebfinger(env.DB, `acct:carol@${HOST}`, { id: 999, isAdmin: true, loginLower: "root" }, opts);
    expect(adminView.kind).toBe("found");

    const signedInView = await resolveWebfinger(env.DB, `acct:dave@${HOST}`, { id: 999, isAdmin: false, loginLower: "eve" }, opts);
    expect(signedInView.kind).toBe("found");

    // The private row still hides from a signed-in stranger (the ladder's
    // follow/org arms are the landed predicate's own suite's).
    const strangerView = await resolveWebfinger(env.DB, `acct:carol@${HOST}`, { id: 999, isAdmin: false, loginLower: "eve" }, opts);
    expect(strangerView.kind).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// The gated API stubs — api.go:1007-1010 + person.go:12-14
// ---------------------------------------------------------------------------

describe("the /api/v1 stubs — registration gate", () => {
  it("disabled: both arms answer the router's native 404 (unregistered at api.go:1007)", async () => {
    for (const federation of [undefined, "false"]) {
      const nodeinfo = await api("/nodeinfo", {}, { federation });
      expect(nodeinfo.status, "nodeinfo disabled").toBe(404);
      expect(await nodeinfo.text(), "nodeinfo disabled").toBe("404 Not Found");

      const activitypub = await api("/activitypub/user-id/1", { method: "POST" }, { federation });
      expect(activitypub.status, "activitypub disabled").toBe(404);
      expect(await activitypub.text(), "activitypub disabled").toBe("404 Not Found");
    }
  });
});

describe("the /api/v1 arms — the gate and the scope ladder", () => {
  it("GET /nodeinfo keeps the W-B1 stub: Go http.Error's exact `Not implemented` line at 501", async () => {
    const response = await api("/nodeinfo", {}, { federation: "true" });
    expect(response.status).toBe(501);
    expect(await response.text()).toBe("Not implemented\n");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("unregistered /activitypub/* sub-paths answer the router's native 404 (the pre-stub registration shape)", async () => {
    for (const path of [
      "/activitypub/anything/deeper/still",
      "/activitypub/user/1", // the deprecated /user/{username} form — never carried (upstream's "remove in 1.20")
      "/activitypub/user-id/",
      "/activitypub",
    ]) {
      const response = await api(path, {}, { federation: "true" });
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe("404 Not Found");
    }
  });

  it("the activitypub scope gate: a token without the category 403s with api.go:300's body", async () => {
    const response = await api("/activitypub/user-id/1", {}, { federation: "true", auth: authWithScope("read:repository") });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(scopeForbidden("read:activitypub", "read:repository"));
  });

  it("a no-token-scope token 403s the gated arm while /nodeinfo stays gate-free", async () => {
    // /nodeinfo carries NO scope gate upstream (api.go:1008) — a tokened
    // caller stubs identically.
    const nodeinfo = await api("/nodeinfo", {}, { federation: "true", auth: authWithScope("read:repository") });
    expect(nodeinfo.status).toBe(501);

    // The scopeless credential (no-token-scope — the empty bitmap) fails
    // every gated path, as upstream and as the central table's semantics
    // (scope-gate.ts:58-59).
    const scopeless = await api("/activitypub/user-id/1", {}, { federation: "true", auth: authWithScope("no-token-scope") });
    expect(scopeless.status).toBe(403);
    expect(await scopeless.json()).toEqual(scopeForbidden("read:activitypub", "no-token-scope"));
  });

  it("the method-derived level: read passes GET at the actor, write required for the inbox POST (api.go:285-289)", async () => {
    const alice = await seedUser({ username: "alice" });

    // A read-category token reaches the GET handler (404 = the assignment
    // middleware answered; unknown id 1, seeded user sits elsewhere).
    const readGet = await api("/activitypub/user-id/1", {}, { federation: "true", auth: authWithScope("read:activitypub") });
    expect(readGet.status).toBe(404);
    expect((await readGet.json<{ message: string }>()).message).toContain("user does not exist");

    // The same token misses the inbox POST's write level...
    const readPost = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, '{"type":"Follow"}', {
      auth: authWithScope("read:activitypub"),
    });
    expect(readPost.status).toBe(403);
    expect(await readPost.json()).toEqual(scopeForbidden("write:activitypub", "read:activitypub"));

    // ...a write-category token passes it (404 here = the unknown-user arm
    // of a path targeting a nonexistent inbox — the gate is behind us).
    const writePostUnknown = await api("/activitypub/user-id/1/inbox", { method: "POST", body: "{}" }, { federation: "true", auth: authWithScope("write:activitypub") });
    expect(writePostUnknown.status).toBe(404);

    // `all` carries every category at both levels.
    const allGet = await api(`/activitypub/user-id/${alice.id}`, {}, { federation: "true", auth: authWithScope("all") });
    expect(allGet.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The method arms — chi's tree/mux mechanics (the 7538a40 adjudication:
// 405+Allow exactly where chi would, NO HEAD→GET fallback, the bare-405
// pre-tree arm for unknown methods, each 405 gate-independence per its
// registration shape). HEAD bodies read "" because Hono's auto-HEAD
// wrapper strips bodies — the fetch spec does the same upstream.
// ---------------------------------------------------------------------------

describe("the method arms — chi's 405 tree, no HEAD fallback", () => {
  const wellKnownVia = async (path: string, init: RequestInit, federation?: string): Promise<Response> =>
    await wellKnownRouter.request(`${ORIGIN}${path}`, init, familyEnv(federation));

  it("web pair: HEAD/OPTIONS/POST tree-405 + Allow: GET with an empty body, enabled", async () => {
    for (const method of ["HEAD", "OPTIONS", "POST"]) {
      const nodeinfo = await wellKnownVia("/.well-known/nodeinfo", { method }, "true");
      expect(nodeinfo.status, `nodeinfo ${method}`).toBe(405);
      expect(nodeinfo.headers.get("allow"), `nodeinfo ${method}`).toBe("GET");
      expect(await nodeinfo.text(), `nodeinfo ${method}`).toBe("");

      const webfinger = await wellKnownVia("/.well-known/webfinger", { method }, "true");
      expect(webfinger.status, `webfinger ${method}`).toBe(405);
      expect(webfinger.headers.get("allow"), `webfinger ${method}`).toBe("GET");
      expect(await webfinger.text(), `webfinger ${method}`).toBe("");
    }
  });

  it("web pair: the tree 405 is gate-INDEPENDENT (web.go:534-535 registers unconditionally)", async () => {
    const head = await wellKnownVia("/.well-known/nodeinfo", { method: "HEAD" }, "false");
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");

    const options = await wellKnownVia("/.well-known/webfinger", { method: "OPTIONS" }, undefined);
    expect(options.status).toBe(405);
    expect(options.headers.get("allow")).toBe("GET");
  });

  it("web pair: the tree 405 is gate-INDEPENDENT (web.go:534-535 registers unconditionally)", async () => {
    const head = await wellKnownVia("/.well-known/nodeinfo", { method: "HEAD" }, "false");
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");

    const options = await wellKnownVia("/.well-known/webfinger", { method: "OPTIONS" }, undefined);
    expect(options.status).toBe(405);
    expect(options.headers.get("allow")).toBe("GET");
  });

  it("an unknown method bare-405s with NO Allow — the byte shape (routeHTTP's pre-tree arm)", async () => {
    // Workers' Request constructor rejects non-methodMap tokens (BREW and
    // chi's QUERY placeholder both throw), so the wire dispatch is pinned
    // over the constructible methods above and the bare-405 shape here —
    // chiMethodNotAllowed skipping the Allow header for unknown methods.
    const bare = chiMethodNotAllowed("BREW", ["GET"]);
    expect(bare.status).toBe(405);
    expect(bare.headers.get("allow")).toBeNull();
    expect(await bare.text()).toBe("");

    // QUERY IS in chi's methodMap (tree.go methodQuery) and carries the
    // Allow line — though no request can carry the token past the runtime.
    const allowed = chiMethodNotAllowed("QUERY", ["GET"]);
    expect(allowed.status).toBe(405);
    expect(allowed.headers.get("allow")).toBe("GET");
  });

  it("API /nodeinfo enabled: HEAD/OPTIONS/POST tree-405 + Allow: GET; GET stays the 501", async () => {
    for (const method of ["HEAD", "OPTIONS", "POST"]) {
      const response = await api("/nodeinfo", { method }, { federation: "true" });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET");
      expect(await response.text(), method).toBe("");
    }
    const get = await api("/nodeinfo", {}, { federation: "true" });
    expect(get.status).toBe(501);
    expect(await get.text()).toBe("Not implemented\n");
  });

  it("API /nodeinfo disabled: unregistered — known methods answer the native 404", async () => {
    // HEAD strips the body at the auto-HEAD wrapper (the wire shape net/http
    // produces too); OPTIONS keeps the native not-found body.
    const head = await api("/nodeinfo", { method: "HEAD" }, { federation: undefined });
    expect(head.status).toBe(404);

    const options = await api("/nodeinfo", { method: "OPTIONS" }, { federation: "false" });
    expect(options.status).toBe(404);
    expect(await options.text()).toBe("404 Not Found");
  });

  it("API activitypub arms: every known non-registered method tree-405s with Allow, BEFORE the scope gate", async () => {
    await seedUser({ username: "alice" });
    for (const method of ["HEAD", "OPTIONS", "POST", "PUT", "DELETE"]) {
      const actor = await api("/activitypub/user-id/1", { method }, { federation: "true" });
      expect(actor.status, `actor ${method}`).toBe(405);
      expect(actor.headers.get("allow"), `actor ${method}`).toBe("GET");
      expect(await actor.text(), `actor ${method}`).toBe("");
    }
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]) {
      const inbox = await api("/activitypub/user-id/1/inbox", { method }, { federation: "true" });
      expect(inbox.status, `inbox ${method}`).toBe(405);
      expect(inbox.headers.get("allow"), `inbox ${method}`).toBe("POST");
      expect(await inbox.text(), `inbox ${method}`).toBe("");
    }

    // chi-exact: the 405 is the mux's default handler — NO endpoint
    // middleware runs, so even a foreign-category token 405s (not 403s).
    const gateless = await api("/activitypub/user-id/1", { method: "PUT" }, { federation: "true", auth: authWithScope("read:repository") });
    expect(gateless.status).toBe(405);
    expect(gateless.headers.get("allow")).toBe("GET");
  });

  it("API activitypub arms disabled: unregistered — every known method answers the native 404", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
      const response = await api("/activitypub/user-id/1", { method }, { federation: undefined });
      expect(response.status, `actor ${method}`).toBe(404);
    }
    const inboxOptions = await api("/activitypub/user-id/1/inbox", { method: "OPTIONS" }, { federation: "false" });
    expect(inboxOptions.status).toBe(404);
    expect(await inboxOptions.text()).toBe("404 Not Found");
  });
});

// ---------------------------------------------------------------------------
// TIER B — the Person actor (SPEC §6.2 W-B2 as-built; person.go:20-79 at
// `1592576fa5^`): the deleted integration test's pins re-armed
// (TestActivityPubPerson.ExistingPerson / MissingPerson)
// ---------------------------------------------------------------------------

describe("GET /activitypub/user-id/{id} — the Person actor", () => {
  it("serves the Person document at the ActivityStreams content type (the deleted test's pins)", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });
    const actorIri = `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`;

    const response = await api(`/activitypub/user-id/${alice.id}`, {}, { federation: "true" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(ACTIVITY_STREAMS_CONTENT_TYPE);

    const body = await response.text();
    expect(body).toContain("@context"); // the deleted test's first assertion
    const person = JSON.parse(body) as Record<string, unknown>;
    expect(person["@context"]).toEqual([
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ]);
    expect(person.id).toBe(actorIri); // numeric-ID IRI — the username is NOT in the path
    expect(person.type).toBe("Person");
    expect(person.preferredUsername).toBe("alice");
    expect(person.url).toBe(`${ORIGIN}/alice`);
    expect(person.inbox).toBe(`${actorIri}/inbox`); // the deleted test's Regexp pins
    expect(person.outbox).toBe(`${actorIri}/outbox`);
    expect(person.name).toBe("");

    const publicKey = person.publicKey as Record<string, unknown>;
    expect(publicKey.id).toBe(`${actorIri}#main-key`);
    expect(publicKey.owner).toBe(actorIri);
    const publicKeyPem = publicKey.publicKeyPem as string;
    expect(publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);

    expect(person.icon).toEqual({ type: "Image", mediaType: "image/png", url: `${ORIGIN}/avatars/alice` });
  });

  it("Name = FullName; icon rides the canonical house avatar projection", async () => {
    const bob = await seedUser({ username: "bob", fullName: "Bob van Example" });
    const response = await api(`/activitypub/user-id/${bob.id}`, {}, { federation: "true" });
    const person = await response.json<Record<string, unknown>>();
    expect(person.name).toBe("Bob van Example");
  });

  it("an org row serves a Person document too — GetUserByID is type-blind (UserIDAssignmentAPI)", async () => {
    const acme = await seedUser({ username: "acme", type: "org" });
    const response = await api(`/activitypub/user-id/${acme.id}`, {}, { federation: "true" });
    expect(response.status).toBe(200);
    const person = await response.json<Record<string, unknown>>();
    expect(person.type).toBe("Person");
    expect(person.preferredUsername).toBe("acme");
  });

  it("a missing user 404s with ErrUserNotExist's exact message (the deleted test's MissingPerson)", async () => {
    const response = await api("/activitypub/user-id/999999999", {}, { federation: "true" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      message: "user does not exist [uid: 999999999, name: ]",
      url: `${ORIGIN}/api/swagger`,
    });
  });

  it("a garbage id collapses to 0 (Go PathParamInt64 ignores the ParseInt error)", async () => {
    const response = await api("/activitypub/user-id/abc", {}, { federation: "true" });
    expect(response.status).toBe(404);
    expect((await response.json<{ message: string }>()).message).toBe("user does not exist [uid: 0, name: ]");
  });

  it("the AppURL chain drives the IRIs (the APP_URL var)", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await api(`/activitypub/user-id/${alice.id}`, {}, { federation: "true", appUrl: "https://custom.example" });
    expect(response.status).toBe(200);
    const person = await response.json<Record<string, unknown>>();
    expect(person.id).toBe(`https://custom.example/api/v1/activitypub/user-id/${alice.id}`);
    expect(person.inbox).toBe(`https://custom.example/api/v1/activitypub/user-id/${alice.id}/inbox`);
  });
});

describe("the actor keypair — lazy RSA-3072 in user_settings_kv (user_settings.go)", () => {
  it("the served publicKeyPem is STABLE across serves (the debian.ts race posture)", async () => {
    const alice = await seedUser({ username: "alice" });
    const first = await api(`/activitypub/user-id/${alice.id}`, {}, { federation: "true" });
    const second = await api(`/activitypub/user-id/${alice.id}`, {}, { federation: "true" });
    const pemOf = async (response: Response): Promise<string> => {
      const person = await response.json<{ publicKey: { publicKeyPem: string } }>();
      return person.publicKey.publicKeyPem;
    };
    const pemFirst = await pemOf(first);
    expect(await pemOf(second)).toBe(pemFirst);

    // The stored pair lives under OUR setting keys — both rows present.
    const rows = await env.DB.prepare("SELECT setting_key FROM user_settings_kv WHERE user_id = ?").bind(alice.id).all<{ setting_key: string }>();
    const keys = rows.results.map((row) => row.setting_key).sort();
    expect(keys).toEqual(["activitypub.priv_pem", "activitypub.pub_pem"]);
  });

  it("getOrCreateActorPublicKey round-trips; deleting the rows regenerates", async () => {
    const alice = await seedUser({ username: "alice" });
    const first = await getOrCreateActorPublicKey(env.DB, alice.id);
    expect(first.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(await getOrCreateActorPublicKey(env.DB, alice.id)).toBe(first);

    await env.DB.prepare("DELETE FROM user_settings_kv WHERE user_id = ?").bind(alice.id).run();
    const regenerated = await getOrCreateActorPublicKey(env.DB, alice.id);
    expect(regenerated.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(regenerated).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// TIER B — the inbox (person.go:81-96 behind reqsignature.go at
// `1592576fa5^`): the deleted test's MissingPersonInbox posture re-armed
// (unsigned → the 500 error arm; verified → the 204 black hole), with the
// completion directive's Follow→Accept ladder on top — durable since S-1
// (the federation_followers store, migration 0063: the verified Follow
// persists, the Undo removes, the re-Follow is a no-op; every RESPONSE byte
// stays the pre-S-1 as-built's — the store is response-invisible)
// ---------------------------------------------------------------------------

describe("POST /activitypub/user-id/{id}/inbox — the signature gate", () => {
  it("an unsigned POST is the upstream ERROR arm: house 500 (APIErrorInternal), the deleted test's pin", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await api(`/activitypub/user-id/${alice.id}/inbox`, { method: "POST", body: "{}" }, { federation: "true" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "internal server error", url: `${ORIGIN}/api/swagger` });
  });

  it("a garbage signature VALUE inside a well-formed param list is the rejected arm", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, "{}", { signature: "!!!!" });
    // The header parses; every pre-crypto arm passes; base64Decode("!!!!")
    // throws at the v.Verify stage → rejected (upstream's Verify-error →
    // authenticated=false → 403 mapping).
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "request signature verification failed", url: `${ORIGIN}/api/swagger` });
  });

  it("a param-list that parses to nothing is the error arm", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await api(`/activitypub/user-id/${alice.id}/inbox`, {
      method: "POST",
      body: "{}",
      headers: { signature: "not-a-param-list" },
    }, { federation: "true" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "internal server error", url: `${ORIGIN}/api/swagger` });
  });

  it("a tampered body (digest mismatch) is the REJECTED arm: the exact 403 body", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, '{"type":"Follow","x":1}', {
      digest: await computeSha256Digest(new TextEncoder().encode('{"type":"Follow"}')),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "request signature verification failed", url: `${ORIGIN}/api/swagger` });
  });

  it("a stale Date past the deleted client's 60 s expiry → 403", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, "{}", {
      date: "Mon, 02 Jan 2006 15:04:05 GMT",
    });
    expect(response.status).toBe(403);
    expect((await response.json<{ message: string }>()).message).toBe("request signature verification failed");
  });

  it("a foreign signer against the doc's key → 403", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, "{}", { keyPair: foreignPair });
    expect(response.status).toBe(403);
  });

  it("a keyId whose document carries a different publicKey.id → the 500 error arm", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, "{}", {
      docBody: remoteActorDoc("https://remote.example/actors/alice#main-key", remotePem),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "internal server error", url: `${ORIGIN}/api/swagger` });
  });

  it("an unknown keyId fails closed — fetch miss and network error are both the 500 arm", async () => {
    const alice = await seedUser({ username: "alice" });
    const miss = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, "{}", { docStatus: 404 });
    expect(miss.status).toBe(500);

    const down = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, "{}", { fetchError: true });
    expect(down.status).toBe(500);
  });

  it("an unsupported algorithm parameter → 403", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, "{}", { algorithm: "hs2019" });
    expect(response.status).toBe(403);
  });

  it("the assignment middleware runs BEFORE the signature: an unknown target 404s unsigned", async () => {
    const response = await api("/activitypub/user-id/999999999/inbox", { method: "POST", body: "{}" }, { federation: "true" });
    expect(response.status).toBe(404);
    expect((await response.json<{ message: string }>()).message).toBe("user does not exist [uid: 999999999, name: ]");
  });

  it("an over-MaxSize body is the 413 size arm (the bounded read, SPEC §3.1)", async () => {
    const alice = await seedUser({ username: "alice" });
    const big = `{"x":"${"y".repeat(4 * 1024 * 1024)}"}`;
    const response = await api(`/activitypub/user-id/${alice.id}/inbox`, { method: "POST", body: big }, { federation: "true" });
    expect(response.status).toBe(413);
  });
});

describe("POST /activitypub/user-id/{id}/inbox — the Follow→Accept ladder, the S-1 store, and the black hole", () => {
  it("a verified Follow answers 200 with the inline Accept — actor, to, and the verbatim object echo", async () => {
    const alice = await seedUser({ username: "alice" });
    const actorIri = `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`;
    const follow = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/1",
      type: "Follow",
      actor: REMOTE_ACTOR_IRI,
      object: actorIri,
    };

    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, JSON.stringify(follow));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(ACTIVITY_STREAMS_CONTENT_TYPE);

    const accept = await response.json<Record<string, unknown>>();
    expect(accept["@context"]).toBe("https://www.w3.org/ns/activitystreams");
    expect(accept.type).toBe("Accept");
    expect(accept.actor).toBe(actorIri);
    expect(accept.to).toBe(REMOTE_ACTOR_IRI);
    expect(accept.object).toEqual(follow); // the received Follow, verbatim
    expect((accept.id as string).startsWith(`${actorIri}#accepts/`)).toBe(true);
  });

  it("a Follow with an embedded actor object reads `to` from its id (the signer-bound embedded form)", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;

    // The embedded-object actor form carrying the SIGNER's own IRI — the
    // valid shape; `to` reads the embedded `id`. (An embedded actor naming
    // someone else is the cross-actor mismatch — pinned in the signer-
    // binding battery below.)
    const embedded = await signedInbox(path, JSON.stringify({
      type: "Follow",
      actor: { type: "Person", id: REMOTE_ACTOR_IRI },
      object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`,
    }));
    expect(embedded.status).toBe(200);
    expect((await embedded.json<Record<string, unknown>>()).to).toBe(REMOTE_ACTOR_IRI);
  });

  it("every other verified activity keeps the upstream 204 black hole (PersonInbox verbatim)", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;

    for (const activity of [
      { type: "Create", object: { type: "Note", content: "hi" } },
      // The Undo is in this list as a RESPONSE pin: with nothing stored its
      // removal arm is a no-op and the bytes stay the black hole's (the
      // stored-row removal is pinned in the S-1 tests below in this
      // describe).
      { type: "Undo", object: { type: "Follow", actor: REMOTE_ACTOR_IRI, object: REMOTE_KEY_ID } },
      { type: "Delete", object: REMOTE_ACTOR_IRI },
    ]) {
      const response = await signedInbox(path, JSON.stringify(activity));
      expect(response.status, activity.type).toBe(204);
      expect(await response.text(), activity.type).toBe("");
    }
  });

  it("a signed but malformed JSON body → 400 (the arm the black hole never needed)", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, "not-json-at-all");
    expect(response.status).toBe(400);
    expect((await response.json<{ message: string }>()).message).toBe("Bad Request");
  });

  it("a verified Follow PERSISTS the follower (S-1, migration 0063) — the Accept bytes unchanged", async () => {
    const alice = await seedUser({ username: "alice" });
    const follow = {
      type: "Follow",
      actor: REMOTE_ACTOR_IRI,
      object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`,
    };
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, JSON.stringify(follow));
    // The response is EXACTLY the pre-S-1 as-built's — the store is
    // response-invisible (status, content-type, the Accept shape above).
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(ACTIVITY_STREAMS_CONTENT_TYPE);
    const accept = await response.json<Record<string, unknown>>();
    expect(accept.type).toBe("Accept");
    expect(accept.to).toBe(REMOTE_ACTOR_IRI);
    expect(accept.object).toEqual(follow);

    // The store: one row, keyed to the inbox's user and the actor IRI.
    const rows = await env.DB.prepare(
      "SELECT user_id, follower_iri FROM federation_followers",
    ).all<{ user_id: number; follower_iri: string }>();
    expect(rows.results).toEqual([{ user_id: alice.id, follower_iri: REMOTE_ACTOR_IRI }]);
  });

  it("a re-Follow is idempotent: still ONE row, the original untouched (no delete-and-reinsert)", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;
    const follow = JSON.stringify({ type: "Follow", actor: REMOTE_ACTOR_IRI, object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` });
    expect((await signedInbox(path, follow)).status).toBe(200);

    const first = await env.DB.prepare(
      "SELECT id, created_at FROM federation_followers WHERE follower_iri = ?",
    ).bind(REMOTE_ACTOR_IRI).first<{ id: number; created_at: number }>();
    expect(first).not.toBeNull();

    // The re-Follow: same 200 Accept ladder, but the UNIQUE pair makes the
    // write a no-op — the original row (id + created_at) survives verbatim.
    expect((await signedInbox(path, follow)).status).toBe(200);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(count?.n).toBe(1);
    const second = await env.DB.prepare(
      "SELECT id, created_at FROM federation_followers WHERE follower_iri = ?",
    ).bind(REMOTE_ACTOR_IRI).first<{ id: number; created_at: number }>();
    expect(second).toEqual(first);
  });

  it("an actorless Follow binds to nothing — the silent 204, no Accept, no row", async () => {
    const alice = await seedUser({ username: "alice" });
    const response = await signedInbox(`/activitypub/user-id/${alice.id}/inbox`, JSON.stringify({ type: "Follow" }));
    // No actor = no identity to bind to the verified signer (the pre-freeze
    // fix: the old actorless arm answered an `Accept` with no `to` — a
    // response no verified actor earned). Nothing persists, nothing is
    // answered — upstream's own black-hole posture.
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("a verified Undo removes the stored row — silent 204, byte-identical to the black hole", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;
    const follow = JSON.stringify({ type: "Follow", actor: REMOTE_ACTOR_IRI, object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` });
    expect((await signedInbox(path, follow)).status).toBe(200);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(before?.n).toBe(1);

    // The Undo carries the Follow verbatim (the Accept's own object echo is
    // exactly this shape) — the removal is keyed to the embedded actor.
    const undo = JSON.stringify({
      type: "Undo",
      actor: REMOTE_ACTOR_IRI,
      object: { type: "Follow", actor: REMOTE_ACTOR_IRI, object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` },
    });
    const response = await signedInbox(path, undo);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(after?.n).toBe(0);
  });

  it("an Undo with a bare-IRI cargo keys on the Undo's own actor; a stranger's Undo touches nothing", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;
    const follow = JSON.stringify({ type: "Follow", actor: REMOTE_ACTOR_IRI, object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` });
    expect((await signedInbox(path, follow)).status).toBe(200);

    // A stranger's Undo naming the stranger (mallory's actor in both the
    // Undo and its embedded Follow, signed by BOB's key): bob's row
    // survives — twice over, as-built. The signer gate rejects it first
    // (the removal key mallory ≠ the verified signer bob), and a
    // mallory-SIGNED variant would fail the same equality identically; the
    // (user_id, follower_iri) pair key bounds removals to THIS inbox's rows
    // (the inbox OWNER) — it never bounded the sender. The signer-naming-
    // victim arms are pinned directly in the battery below.
    const strangerUndo = JSON.stringify({
      type: "Undo",
      actor: "https://remote.example/actors/mallory",
      object: { type: "Follow", actor: "https://remote.example/actors/mallory", object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` },
    });
    const stranger = await signedInbox(path, strangerUndo);
    expect(stranger.status).toBe(204);
    let count = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(count?.n).toBe(1);

    // The bare-IRI cargo (no embedded Follow): the fallback key is the
    // Undo's own actor — bob's own undo removes bob's row.
    const bareUndo = JSON.stringify({
      type: "Undo",
      actor: REMOTE_ACTOR_IRI,
      object: "https://remote.example/activities/1",
    });
    const bare = await signedInbox(path, bareUndo);
    expect(bare.status).toBe(204);
    count = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("the user-delete cascade drops the follower rows (ON DELETE CASCADE, schema.ts)", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;
    const follow = JSON.stringify({ type: "Follow", actor: REMOTE_ACTOR_IRI, object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` });
    expect((await signedInbox(path, follow)).status).toBe(200);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(before?.n).toBe(1);

    // The user purge path needs no per-table cascade lines — the declared
    // FK carries the deletion (the schema.test.ts cascade-pin posture).
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(alice.id).run();
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(after?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The signer binding (the 2026-11-03 pre-freeze fix): the inbox's accepted
// verification outcome carries the VERIFIED keyId; both arms — the Follow's
// persist+Accept and the Undo's removal — bind their keys to that signer
// identity, bare-IRI normalized on BOTH sides (the `{actorIRI}#main-key`
// fragment stripped from the keyId, and from the claimed actor, which may
// itself carry a fragment). A mismatch is the same silent 204 on both arms.
// No upstream cite exists for the binding (upstream's inbox was a 204 black
// hole — it never parsed bodies); the derivation is our SPEC's fallback arm
// plus the ActivityPub contract that an Undo's actor is the undone
// activity's author (specs/federation.md §5 as-built).
// ---------------------------------------------------------------------------

describe("POST /activitypub/user-id/{id}/inbox — the signer binding", () => {
  it("a cross-actor Follow persists nothing — the claimed actor must BE the verified signer", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;

    // Mallory signs validly; the body names BOB. Before the binding this
    // persisted bob's row (fabricated follow attribution); now: no Accept,
    // no row — the silent 204.
    const stringForm = await malloryInbox(path, JSON.stringify({
      type: "Follow",
      actor: REMOTE_ACTOR_IRI,
      object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`,
    }));
    expect(stringForm.status).toBe(204);
    expect(await stringForm.text()).toBe("");

    // The embedded-object actor form is bound the same way.
    const embeddedForm = await malloryInbox(path, JSON.stringify({
      type: "Follow",
      actor: { type: "Person", id: REMOTE_ACTOR_IRI },
      object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`,
    }));
    expect(embeddedForm.status).toBe(204);
    expect(await embeddedForm.text()).toBe("");

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM federation_followers").first<{ n: number }>();
    expect(count?.n).toBe(0);

    // The control: the same signer naming HERSELF is the valid path — the
    // gate is the mismatch, not the signer.
    const self = await malloryInbox(path, JSON.stringify({
      type: "Follow",
      actor: MALLORY_ACTOR_IRI,
      object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`,
    }));
    expect(self.status).toBe(200);
    const accept = await self.json<Record<string, unknown>>();
    expect(accept.type).toBe("Accept");
    expect(accept.to).toBe(MALLORY_ACTOR_IRI);
    const rows = await env.DB.prepare("SELECT follower_iri FROM federation_followers").all<{ follower_iri: string }>();
    expect(rows.results).toEqual([{ follower_iri: MALLORY_ACTOR_IRI }]);
  });

  it("a cross-actor embedded Undo cannot delete the victim's row — the removal key must BE the signer", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;
    const follow = JSON.stringify({ type: "Follow", actor: REMOTE_ACTOR_IRI, object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` });
    expect((await signedInbox(path, follow)).status).toBe(200);

    // Mallory signs validly; the embedded Follow names BOB. Before the
    // binding this silently deleted bob's stored row; now the removal key
    // (bob) misses the verified signer (mallory) — a no-op, the same silent
    // 204, no existence leak either way.
    const forged = await malloryInbox(path, JSON.stringify({
      type: "Undo",
      actor: MALLORY_ACTOR_IRI,
      object: { type: "Follow", actor: REMOTE_ACTOR_IRI, object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` },
    }));
    expect(forged.status).toBe(204);
    expect(await forged.text()).toBe("");

    let rows = await env.DB.prepare("SELECT follower_iri FROM federation_followers").all<{ follower_iri: string }>();
    expect(rows.results).toEqual([{ follower_iri: REMOTE_ACTOR_IRI }]);

    // The row survived intact and removable: bob's OWN undo still drops it.
    const own = await signedInbox(path, JSON.stringify({
      type: "Undo",
      actor: REMOTE_ACTOR_IRI,
      object: { type: "Follow", actor: REMOTE_ACTOR_IRI, object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}` },
    }));
    expect(own.status).toBe(204);
    rows = await env.DB.prepare("SELECT follower_iri FROM federation_followers").all<{ follower_iri: string }>();
    expect(rows.results).toEqual([]);
  });

  it("the #main-key keyId normalizes to its bare actor IRI; the actor side may carry the fragment too", async () => {
    const alice = await seedUser({ username: "alice" });
    const path = `/activitypub/user-id/${alice.id}/inbox`;

    // Canonical direction (implicitly pinned by every valid test above):
    // keyId = `…/bob#main-key`, body actor = bare `…/bob` — the sides match
    // on the bare IRI. The mirrored direction here: the body's actor ITSELF
    // carries a fragment — same bare IRI, still the signer, still valid;
    // the persisted row and the Accept's `to` carry the BARE IRI (the
    // stored identity, so a fragment-carrying re-Follow stays the same row
    // and a fragment-carrying Undo still removes it).
    const response = await signedInbox(path, JSON.stringify({
      type: "Follow",
      actor: `${REMOTE_ACTOR_IRI}#main-key`,
      object: `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`,
    }));
    expect(response.status).toBe(200);
    const accept = await response.json<Record<string, unknown>>();
    expect(accept.type).toBe("Accept");
    expect(accept.to).toBe(REMOTE_ACTOR_IRI);
    const rows = await env.DB.prepare("SELECT follower_iri FROM federation_followers").all<{ follower_iri: string }>();
    expect(rows.results).toEqual([{ follower_iri: REMOTE_ACTOR_IRI }]);
  });
});
