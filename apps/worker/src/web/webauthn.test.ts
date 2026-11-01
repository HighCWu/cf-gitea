/**
 * The WebAuthn routes + store suite — the settings quartet and the login
 * family driven END-TO-END over real D1 (the generated migrations) with the
 * fixed synthetic authenticator (webauthn-fixtures.ts): the full ceremony
 * round-trips through the HTTP arms (the registration enroll, the login
 * gate → assertion options → assertion verify → session mint, the passkey
 * discoverable login), the reject arms at the route boundary (the 409s, the
 * challenge replay 403, the cross-origin 403, the uncarried 500s) and the
 * store CRUD (the sign-count CAS's single-use arm included).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { TokenService } from "../auth/token-service";
import { users, webauthnCredentials } from "../db/schema";
import { mintSession, SESSION_COOKIE_NAME, sessionRouter } from "../ui/session";
import { signCeremonyState, verifyCeremonyState } from "./webauthn-ceremony";
import { base64UrlEncode, sha256, webAuthnIdForUser } from "./webauthn-cose";
import {
  buildAssertionResponse,
  buildAuthData,
  buildCreationResponse,
  clientDataJson,
  FLAG_AT,
  FLAG_UP,
  FLAG_UV,
  FIXED_AAGUID,
  makeEcFixture,
  signWith,
  type EcFixture,
} from "./webauthn-fixtures";
import { createWebAuthnRouter } from "./webauthn";
import {
  applyAssertionSignCount,
  createCredential as createCredentialRow,
  deleteCredential,
  getCredentialByName,
  hasCredentialsForUser,
  listCredentialsByUser,
  renameCredential,
} from "./webauthn-store";

// The request origin Hono synthesizes for router.request(path) — the RP
// derives from the request URL, so the fixtures sign for THIS origin.
const ORIGIN = "http://localhost";

const router = createWebAuthnRouter();
const req = async (path: string, init?: RequestInit): Promise<Response> => router.request(path, init, env);

let ec: EcFixture;

beforeAll(async () => {
  await applyAuthD1Migrations();
  ec = await makeEcFixture();
});

const WIPE_TABLES = ["webauthn_credentials", "sessions", "personal_access_tokens", "auth_failures", "users"];

beforeEach(async () => {
  for (const table of WIPE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

async function seedUser(username = "alice"): Promise<{ id: number; username: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), createdAt: new Date() })
    .returning()
    .all();
  const row = rows[0]!;
  return { id: row.id, username: row.username };
}

/** A signed-in session cookie for the settings arms. */
async function sessionCookieFor(userId: number): Promise<string> {
  const value = await mintSession(env.DB, userId, { remember: false });
  return `${SESSION_COOKIE_NAME}=${value}`;
}

/** Insert an enrolled credential row directly (the login-family fixtures). */
async function enrollCredential(
  userId: number,
  options: { name?: string; credentialId?: Uint8Array; signCount?: number; fixture?: EcFixture } = {},
): Promise<{ id: number; credentialId: Uint8Array }> {
  const fixture = options.fixture ?? ec;
  const credentialId = options.credentialId ?? new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const sec = Math.floor(Date.now() / 1000);
  const row = await drizzle(env.DB)
    .insert(webauthnCredentials)
    .values({
      userId,
      name: options.name ?? "test key",
      lowerName: (options.name ?? "test key").toLowerCase(),
      credentialId,
      publicKey: fixture.coseBytes,
      attestationType: "none",
      aaguid: FIXED_AAGUID,
      signCount: options.signCount ?? 0,
      transports: null,
      cloneWarning: false,
      createdUnix: sec,
      updatedUnix: sec,
    })
    .returning()
    .all();
  return { id: row[0]!.id, credentialId };
}

/** The synthetic assertion body for an enrolled credential. */
async function assertionBody(
  credentialId: Uint8Array,
  options: { challenge: string; origin?: string; rpId?: string; signCount?: number; flags?: number; userHandle?: Uint8Array | null; badSignature?: boolean; fixture?: EcFixture },
): Promise<Record<string, unknown>> {
  const fixture = options.fixture ?? ec;
  const authData = await buildAuthData({
    rpId: options.rpId ?? "localhost",
    flags: options.flags ?? (FLAG_UP | FLAG_UV),
    signCount: options.signCount ?? 1,
  });
  const clientData = clientDataJson("webauthn.get", options.challenge, options.origin ?? ORIGIN);
  const clientHash = await sha256(clientData);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  let signature = await signWith(fixture, signed);
  if (options.badSignature) signature = signature.slice(1);
  return buildAssertionResponse({ credentialId, authData, clientData, signature, userHandle: options.userHandle ?? null });
}

// ---------------------------------------------------------------------------------
// The store (D1-backed)
// ---------------------------------------------------------------------------------

describe("webauthn-store", () => {
  it("creates, lists, renames and deletes credentials (the upstream op set)", async () => {
    const user = await seedUser();
    expect(await hasCredentialsForUser(env.DB, user.id)).toBe(false);

    const created = await createCredentialRow(env.DB, user.id, "My Key", {
      credentialId: new Uint8Array([7, 7]),
      coseKey: ec.cose,
      publicKeyRaw: ec.coseBytes,
      attestationType: "none",
      aaguid: FIXED_AAGUID,
      signCount: 3,
      transports: ["usb"],
      userPresent: true,
      userVerified: true,
    });
    expect(created.name).toBe("My Key");
    expect(created.lowerName).toBe("my key");
    expect(await hasCredentialsForUser(env.DB, user.id)).toBe(true);

    const list = await listCredentialsByUser(env.DB, user.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.transports).toEqual(["usb"]);
    expect(list[0]!.createdUnix).toBeInstanceOf(Date);

    // The case-folded name lookup:
    expect((await getCredentialByName(env.DB, user.id, "MY KEY"))?.id).toBe(created.id);

    // Rename: the taken arm, the not-exist arm, the success (case-folded).
    await createCredentialRow(env.DB, user.id, "Other", {
      credentialId: new Uint8Array([8, 8]),
      coseKey: ec.cose,
      publicKeyRaw: ec.coseBytes,
      attestationType: "none",
      aaguid: FIXED_AAGUID,
      signCount: 0,
      transports: null,
      userPresent: true,
      userVerified: true,
    });
    expect(await renameCredential(env.DB, user.id, created.id, "other")).toBe("name-taken");
    expect(await renameCredential(env.DB, user.id, 9999, "x")).toBe("not-exist");
    expect(await renameCredential(env.DB, user.id, created.id, "Renamed")).toBe("renamed");
    expect((await getCredentialByName(env.DB, user.id, "renamed"))?.id).toBe(created.id);

    expect(await deleteCredential(env.DB, user.id, created.id)).toBe(true);
    expect(await deleteCredential(env.DB, user.id, created.id)).toBe(false);
  });

  it("the sign-count CAS moves the counter exactly once (the single-use arm)", async () => {
    const user = await seedUser();
    const cred = await enrollCredential(user.id, { signCount: 5 });
    expect(await applyAssertionSignCount(env.DB, cred.id, 5, 6, false)).toBe("applied");
    // The same (old=5) precondition can never win again:
    expect(await applyAssertionSignCount(env.DB, cred.id, 5, 6, false)).toBe("counter-moved");
    const rows = await env.DB.prepare("SELECT sign_count, clone_warning FROM webauthn_credentials WHERE id = ?")
      .bind(cred.id)
      .all<{ sign_count: number; clone_warning: number }>();
    expect(rows.results[0]?.sign_count).toBe(6);
    expect(rows.results[0]?.clone_warning).toBe(0);
    // The clone arm persists the warning:
    expect(await applyAssertionSignCount(env.DB, cred.id, 6, 6, true)).toBe("applied");
    const flagged = await env.DB.prepare("SELECT clone_warning FROM webauthn_credentials WHERE id = ?").bind(cred.id).all<{ clone_warning: number }>();
    expect(flagged.results[0]?.clone_warning).toBe(1);
  });
});

// ---------------------------------------------------------------------------------
// The settings quartet
// ---------------------------------------------------------------------------------

describe("the settings quartet", () => {
  it("enrolls a credential end-to-end: request_register → register → 201 + row", async () => {
    const user = await seedUser();
    const cookie = await sessionCookieFor(user.id);

    // request_register: the options shape + the reg carrier.
    const requestRes = await req("/user/settings/security/webauthn/request_register", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: "name=work+key",
    });
    expect(requestRes.status).toBe(200);
    const options = await requestRes.json<{ publicKey: Record<string, unknown> }>();
    expect((options.publicKey.rp as Record<string, unknown>).id).toBe("localhost");
    expect(Array.isArray(options.publicKey.excludeCredentials)).toBe(true);
    const regCookie = requestRes.headers.get("set-cookie") ?? "";
    expect(regCookie).toContain("gitea_webauthn=");

    // The vendored JS's register POST — a synthetic none-attestation over
    // the ISSUED challenge (read back from the carrier).
    const raw = regCookie.split(";")[0]!.split("=").slice(1).join("=");
    const state = await verifyCeremonyState(env.DB, decodeURIComponent(raw), "reg");
    expect(state?.name).toBe("work key");
    const credentialId = new Uint8Array([0xc0, 0xff, 0xee]);
    const authData = await buildAuthData({
      rpId: "localhost",
      flags: FLAG_UP | FLAG_UV | FLAG_AT,
      signCount: 9,
      attested: { aaguid: FIXED_AAGUID, credentialId, coseKey: ec.coseBytes },
    });
    const clientData = clientDataJson("webauthn.create", state!.ch, ORIGIN);
    const body = buildCreationResponse({ credentialId, authData, clientData, fmt: "none" });
    const registerRes = await req("/user/settings/security/webauthn/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${cookie}; ${regCookie.split(";")[0]!}` },
      body: JSON.stringify(body),
    });
    expect(registerRes.status).toBe(201);

    const rows = await env.DB.prepare("SELECT name, lower_name, attestation_type, sign_count FROM webauthn_credentials WHERE user_id = ?")
      .bind(user.id)
      .all<{ name: string; lower_name: string; attestation_type: string; sign_count: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.name).toBe("work key");
    expect(rows.results[0]?.lower_name).toBe("work key");
    expect(rows.results[0]?.attestation_type).toBe("none");
    expect(rows.results[0]?.sign_count).toBe(9);
  });

  it("rejects a taken nickname at BOTH arms (409) and a missing carrier (500)", async () => {
    const user = await seedUser();
    await enrollCredential(user.id, { name: "taken" });
    const cookie = await sessionCookieFor(user.id);

    const conflict = await req("/user/settings/security/webauthn/request_register", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: "name=TAKEN",
    });
    expect(conflict.status).toBe(409);

    const noState = await req("/user/settings/security/webauthn/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ id: "x", rawId: "x", type: "public-key", response: { attestationObject: "AA", clientDataJSON: "AA" } }),
    });
    expect(noState.status).toBe(500);
  });

  it("a bad attestation answers the ServerError arm (500) and burns the carrier", async () => {
    const user = await seedUser();
    const cookie = await sessionCookieFor(user.id);
    const requestRes = await req("/user/settings/security/webauthn/request_register", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: "name=bad",
    });
    const regCookie = requestRes.headers.get("set-cookie")!.split(";")[0]!;
    // Wrong-challenge attestation:
    const credentialId = new Uint8Array([1]);
    const authData = await buildAuthData({
      rpId: "localhost",
      flags: FLAG_UP | FLAG_UV | FLAG_AT,
      attested: { aaguid: FIXED_AAGUID, credentialId, coseKey: ec.coseBytes },
    });
    const body = buildCreationResponse({
      credentialId,
      authData,
      clientData: clientDataJson("webauthn.create", base64UrlEncode(new Uint8Array(32).fill(9)), ORIGIN),
      fmt: "none",
    });
    const registerRes = await req("/user/settings/security/webauthn/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${cookie}; ${regCookie}` },
      body: JSON.stringify(body),
    });
    expect(registerRes.status).toBe(500);
    // The carrier is consumed even on failure:
    expect(registerRes.headers.get("set-cookie") ?? "").toContain("gitea_webauthn=; Path=/; Max-Age=0");
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM webauthn_credentials WHERE user_id = ?").bind(user.id).all<{ n: number }>();
    expect(rows.results[0]?.n).toBe(0);
  });

  it("rename answers the upstream JSON arms; delete 303s the success and re-renders the miss", async () => {
    const user = await seedUser();
    const cred = await enrollCredential(user.id, { name: "old" });
    const cookie = await sessionCookieFor(user.id);

    const renamed = await req("/user/settings/security/webauthn/rename", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: `id=${cred.id}&name=new+name`,
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json<{ redirect: string }>()).redirect).toBe("/user/settings/security");

    const taken = await req("/user/settings/security/webauthn/rename", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: `id=${cred.id}&name=old`,
    });
    // "old" is the SAME row's name — the no-op success arm:
    expect(taken.status).toBe(200);

    const missing = await req("/user/settings/security/webauthn/rename", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: "id=999&name=x",
    });
    expect(missing.status).toBe(404);

    const removed = await req("/user/settings/security/webauthn/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: `id=${cred.id}`,
    });
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/user/settings/security");

    const miss = await req("/user/settings/security/webauthn/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: "id=999",
    });
    expect(miss.status).toBe(200);
    expect(await miss.text()).toContain("The security key was not found");
  });

  it("carries the house gates: cross-origin 403, anonymous redirect, GET 405 twins", async () => {
    const user = await seedUser();
    const cookie = await sessionCookieFor(user.id);
    const cross = await req("/user/settings/security/webauthn/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: "id=1",
    });
    expect(cross.status).toBe(403);

    const anonymous = await req("/user/settings/security/webauthn/request_register", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: "name=x",
    });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/login?redirect_to=");

    for (const path of ["/user/settings/security/webauthn/request_register", "/user/settings/security/webauthn/register", "/user/settings/security/webauthn/rename", "/user/settings/security/webauthn/delete"]) {
      const res = await req(path, { method: "GET" });
      expect(res.status).toBe(405);
    }
  });
});

// ---------------------------------------------------------------------------------
// The login family
// ---------------------------------------------------------------------------------

describe("the login family", () => {
  it("POST /login parks the pre-auth identity and 303s the prompt (the gate)", async () => {
    const user = await seedUser();
    await enrollCredential(user.id);
    const pat = (await new TokenService(env.DB).mint({ userId: user.id, name: "web", scopes: "read:repository" })).plaintext;

    const res = await sessionRouter.request(
      "/login",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: `password=${encodeURIComponent(pat)}`,
      },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/webauthn");
    const pendingCookie = res.headers.get("set-cookie") ?? "";
    expect(pendingCookie).toContain("gitea_webauthn=");
    expect(pendingCookie).toContain("Max-Age=600");
    // No session row minted yet:
    const sessions = await env.DB.prepare("SELECT count(*) AS n FROM sessions").all<{ n: number }>();
    expect(sessions.results[0]?.n).toBe(0);

    // A user WITHOUT keys mints immediately (the composition point).
    const plain = await seedUser("bob");
    const pat2 = (await new TokenService(env.DB).mint({ userId: plain.id, name: "web", scopes: "read:repository" })).plaintext;
    const direct = await sessionRouter.request(
      "/login",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: `password=${encodeURIComponent(pat2)}`,
      },
      env,
    );
    expect(direct.status).toBe(303);
    expect(direct.headers.get("location")).toBe("/");
    expect(direct.headers.get("set-cookie") ?? "").not.toContain("gitea_webauthn=");
  });

  it("the prompt page renders the wire-contract DOM with a pending carrier (500 without)", async () => {
    const user = await seedUser();
    const pending = await signCeremonyState(env.DB, { k: "pending", uid: user.id, ch: "", rem: true, to: "/dashboard" });
    const carried = await req("/user/webauthn", { headers: { cookie: `gitea_webauthn=${encodeURIComponent(pending)}` } });
    expect(carried.status).toBe(200);
    const html = await carried.text();
    expect(html).toContain("user signin webauthn-prompt"); // the bundle's activation marker
    expect(html).toContain('id="webauthn-error"');
    expect(html).toContain('data-webauthn-error-msg="timeout"');

    const bare = await req("/user/webauthn");
    expect(bare.status).toBe(500); // upstream's "not in WebAuthn session" arm
  });

  it("assertion GET issues the challenge (allowlist included); POST verifies, mints, and single-uses", async () => {
    const user = await seedUser();
    const cred = await enrollCredential(user.id);
    const pending = await signCeremonyState(env.DB, { k: "pending", uid: user.id, ch: "", rem: false, to: "/dashboard" });
    const cookieHeader = `gitea_webauthn=${encodeURIComponent(pending)}`;

    const optionsRes = await req("/user/webauthn/assertion", { headers: { cookie: cookieHeader } });
    expect(optionsRes.status).toBe(200);
    const options = await optionsRes.json<{ publicKey: Record<string, unknown> }>();
    expect(options.publicKey.rpId).toBe("localhost");
    expect(options.publicKey.allowCredentials).toEqual([{ type: "public-key", id: base64UrlEncode(cred.credentialId) }]);
    const assertCookie = (optionsRes.headers.get("set-cookie") ?? "").split(";")[0]!;

    // The POST: the ISSUED challenge, signed for the localhost origin.
    const raw = assertCookie.split("=").slice(1).join("=");
    const state = await verifyCeremonyState(env.DB, decodeURIComponent(raw), "assert");
    expect(state?.ac).toEqual([base64UrlEncode(cred.credentialId)]);
    const body = await assertionBody(cred.credentialId, { challenge: state!.ch });
    const verifyRes = await req("/user/webauthn/assertion", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${cookieHeader}; ${assertCookie}` },
      body: JSON.stringify(body),
    });
    expect(verifyRes.status).toBe(200);
    expect((await verifyRes.json<{ redirect: string }>()).redirect).toBe("/dashboard");
    // The mint + the counter bump + BOTH carriers cleared:
    const sessions = await env.DB.prepare("SELECT count(*) AS n FROM sessions").all<{ n: number }>();
    expect(sessions.results[0]?.n).toBe(1);
    const counter = await env.DB.prepare("SELECT sign_count FROM webauthn_credentials WHERE id = ?").bind(cred.id).all<{ sign_count: number }>();
    expect(counter.results[0]?.sign_count).toBe(1);
    const cleared = verifyRes.headers.getSetCookie ? verifyRes.headers.getSetCookie() : [verifyRes.headers.get("set-cookie") ?? ""];
    expect(cleared.some((value) => value.startsWith("gitea_webauthn=; Path=/; Max-Age=0"))).toBe(true);

    // THE REPLAY: a fresh challenge + the SAME response bytes — the counter
    // did not advance, the durable single-use arm 403s.
    const pending2 = await signCeremonyState(env.DB, { k: "pending", uid: user.id, ch: "", rem: false });
    const options2 = await req("/user/webauthn/assertion", {
      headers: { cookie: `gitea_webauthn=${encodeURIComponent(pending2)}` },
    });
    const assertCookie2 = (options2.headers.get("set-cookie") ?? "").split(";")[0]!;
    const replayRes = await req("/user/webauthn/assertion", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: `gitea_webauthn=${encodeURIComponent(pending2)}; ${assertCookie2}` },
      body: JSON.stringify(body),
    });
    expect(replayRes.status).toBe(403);
  });

  it("assertion rejects: wrong challenge 403, no carriers 500, cross-origin 403", async () => {
    const user = await seedUser();
    const cred = await enrollCredential(user.id);
    const pending = await signCeremonyState(env.DB, { k: "pending", uid: user.id, ch: "", rem: false });
    const cookieHeader = `gitea_webauthn=${encodeURIComponent(pending)}`;

    const optionsRes = await req("/user/webauthn/assertion", { headers: { cookie: cookieHeader } });
    const assertCookie = (optionsRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const wrongChallenge = await assertionBody(cred.credentialId, {
      challenge: base64UrlEncode(new Uint8Array(32).fill(3)),
    });
    const res1 = await req("/user/webauthn/assertion", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${cookieHeader}; ${assertCookie}` },
      body: JSON.stringify(wrongChallenge),
    });
    expect(res1.status).toBe(403);
    expect(await res1.text()).toContain("challenge mismatch");

    // Fresh carriers for the wrong-origin arm (the previous ones burned):
    const pending2 = await signCeremonyState(env.DB, { k: "pending", uid: user.id, ch: "", rem: false });
    const options2 = await req("/user/webauthn/assertion", { headers: { cookie: `gitea_webauthn=${encodeURIComponent(pending2)}` } });
    const assertCookie2 = (options2.headers.get("set-cookie") ?? "").split(";")[0]!;
    const state2 = await verifyCeremonyState(env.DB, decodeURIComponent(assertCookie2.split("=").slice(1).join("=")), "assert");
    const wrongOrigin = await assertionBody(cred.credentialId, { challenge: state2!.ch, origin: "https://evil.example" });
    const res2 = await req("/user/webauthn/assertion", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: `gitea_webauthn=${encodeURIComponent(pending2)}; ${assertCookie2}` },
      body: JSON.stringify(wrongOrigin),
    });
    expect(res2.status).toBe(403);

    const bare = await req("/user/webauthn/assertion", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: "{}" });
    expect(bare.status).toBe(500);

    // The unused-var contract: wrongChallenge flowed through res1.
    expect(wrongChallenge).toBeTruthy();
  });

  it("the passkey pair logs a discoverable credential in by userHandle", async () => {
    const user = await seedUser();
    const cred = await enrollCredential(user.id);
    const optionsRes = await req("/user/webauthn/passkey/assertion", { headers: { origin: ORIGIN } });
    expect(optionsRes.status).toBe(200);
    const options = await optionsRes.json<{ publicKey: Record<string, unknown> }>();
    expect(options.publicKey.allowCredentials).toBeUndefined(); // discoverable
    const assertCookie = (optionsRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const state = await verifyCeremonyState(env.DB, decodeURIComponent(assertCookie.split("=").slice(1).join("=")), "passkey");

    const body = await assertionBody(cred.credentialId, { challenge: state!.ch, userHandle: webAuthnIdForUser(user.id) });
    const res = await req("/user/webauthn/passkey/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: assertCookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ redirect: string }>()).redirect).toBe("/");
    const sessions = await env.DB.prepare("SELECT count(*) AS n FROM sessions").all<{ n: number }>();
    expect(sessions.results[0]?.n).toBe(1);

    // A wrong userHandle 400s (upstream's nil-user arm).
    const options2 = await req("/user/webauthn/passkey/assertion", { headers: { origin: ORIGIN } });
    const assertCookie2 = (options2.headers.get("set-cookie") ?? "").split(";")[0]!;
    const state2 = await verifyCeremonyState(env.DB, decodeURIComponent(assertCookie2.split("=").slice(1).join("=")), "passkey");
    const badHandle = await assertionBody(cred.credentialId, {
      challenge: state2!.ch,
      userHandle: webAuthnIdForUser(999999),
    });
    const res2 = await req("/user/webauthn/passkey/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: assertCookie2 },
      body: JSON.stringify(badHandle),
    });
    expect(res2.status).toBe(400);
  });
});
