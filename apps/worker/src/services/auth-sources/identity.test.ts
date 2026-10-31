/**
 * The identity-ladder suite (specs/external-auth-sources.md §8
 * "Resolution + linking" service arms + the §4.4 state encoder): the
 * oauth2LoginState encoder round-trip with the 8 KiB bound (§7.6 —
 * descriptive fields truncate, externalId/email/name never do), the decode
 * nulls, the dance cookie parse, the constant-time state compare, the
 * ladder's rungs over REAL D1 (the join hit; the stale-link cleanup — an
 * org-linked row is removed and the ladder continues; the miss; the link
 * upsert with v1-empty token columns), and the init-window guard's
 * semantics. The route-level flow lives in oauth2-login.test.ts.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users } from "../../db/schema";
import { serializeOAuth2SourceConfig } from "./cfg";
import {
  decodeOAuth2LoginState,
  encodeOAuth2LoginState,
  externalSignupBlockedByInitWindow,
  linkIdentityToUser,
  oauth2DanceClearCookie,
  oauth2DanceCookieValue,
  oauth2DanceSetCookie,
  OAUTH2_DANCE_COOKIE_NAME,
  OAUTH2_LOGIN_STATE_MAX_BYTES,
  resolveByExternalLogin,
  sanitizeSuggestedUsername,
  suggestedUsername,
  timingSafeStateEqual,
  type ExternalIdentityProfile,
  type OAuth2LoginState,
} from "./identity";
import {
  countLoginSourceUsers,
  createLoginSource,
  ensureExternalLogin,
  getExternalLogin,
  LoginSourceType,
  type LoginSourceRow,
} from "./store";

beforeEach(async () => {
  // Per-test storage isolation resets the D1 schema — re-apply (the
  // helper's documented caution; rows also leak in-instance, so start
  // emptied).
  await applyAuthD1Migrations();
  for (const table of ["external_login_user", "login_source", "sessions", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const oidcCfg = (): string =>
  serializeOAuth2SourceConfig({
    v: 1,
    provider: "openidConnect",
    clientId: "client-id",
    clientSecret: "client-secret",
    discoveryUrl: "https://idp.example.com",
  });

async function seedSource(name = "OIDC"): Promise<LoginSourceRow> {
  return createLoginSource(env.DB, { type: LoginSourceType.OAuth2, name, isActive: true, cfg: oidcCfg() });
}

async function seedUserRow(options: { name: string; type?: "user" | "org"; status?: "active" | "prohibited" }): Promise<number> {
  const result = await env.DB
    .prepare("INSERT INTO users (username, username_lower, type, status, created_at) VALUES (?, ?, ?, ?, unixepoch())")
    .bind(options.name, options.name.toLowerCase(), options.type ?? "user", options.status ?? "active")
    .run();
  return Number(result.meta.last_row_id);
}

const profile = (externalId = "sub-1", extra: Partial<ExternalIdentityProfile> = {}): ExternalIdentityProfile => ({
  externalId,
  email: "jane@example.com",
  name: "Jane Doe",
  nickName: "jane",
  avatarUrl: "https://idp.example.com/a.png",
  firstName: "Jane",
  lastName: "Doe",
  ...extra,
});

describe("the oauth2LoginState encoder (the W1-recorded open item)", () => {
  const dance = (): OAuth2LoginState => ({
    sourceId: 7,
    provider: "openidConnect",
    expectedState: "state-uuid",
    nonce: "nonce-uuid",
    returnTo: "/repo/trunk",
  });

  it("round-trips the §4.4 field set through decode", () => {
    const decoded = decodeOAuth2LoginState(encodeOAuth2LoginState(dance()));
    expect(decoded).toEqual(dance());
  });

  it("emits the fixed key order (the codec discipline)", () => {
    const encoded = encodeOAuth2LoginState(dance());
    expect(Object.keys(JSON.parse(encoded) as Record<string, unknown>)).toEqual(["sourceId", "provider", "expectedState", "nonce", "returnTo"]);
  });

  it("omits absent optionals (never writes undefined members)", () => {
    const encoded = encodeOAuth2LoginState({ sourceId: 1, provider: "openidConnect", expectedState: "s" });
    expect(JSON.parse(encoded) as Record<string, unknown>).toEqual({ sourceId: 1, provider: "openidConnect", expectedState: "s" });
  });

  it("the 8 KiB bound: an overflowing descriptive field truncates and the flow still completes (§7.6)", () => {
    const oversized: OAuth2LoginState = {
      ...dance(),
      avatarUrl: "https://idp.example.com/" + "a".repeat(OAUTH2_LOGIN_STATE_MAX_BYTES),
    };
    const encoded = encodeOAuth2LoginState(oversized);
    expect(encoded.length).toBeLessThanOrEqual(OAUTH2_LOGIN_STATE_MAX_BYTES);
    const decoded = decodeOAuth2LoginState(encoded);
    expect(decoded?.sourceId).toBe(7);
    expect(decoded?.expectedState).toBe("state-uuid");
    expect((decoded?.avatarUrl ?? "").length).toBeLessThan(OAUTH2_LOGIN_STATE_MAX_BYTES);
  });

  it("externalId/email/name NEVER truncate — overflow there fails loudly instead (§7.6)", () => {
    const oversized: OAuth2LoginState = {
      ...dance(),
      externalId: "x".repeat(OAUTH2_LOGIN_STATE_MAX_BYTES + 1),
    };
    expect(() => encodeOAuth2LoginState(oversized)).toThrow(/8192-byte bound/);
  });

  it("decode answers null for garbage, wrong shapes, and mandatory-field misses", () => {
    expect(decodeOAuth2LoginState(null)).toBeNull();
    expect(decodeOAuth2LoginState(undefined)).toBeNull();
    expect(decodeOAuth2LoginState("")).toBeNull();
    expect(decodeOAuth2LoginState("{not json")).toBeNull();
    expect(decodeOAuth2LoginState('"a string"')).toBeNull();
    expect(decodeOAuth2LoginState('{"provider":"openidConnect","expectedState":"s"}')).toBeNull(); // sourceId missing
    expect(decodeOAuth2LoginState('{"sourceId":"x","provider":"openidConnect","expectedState":"s"}')).toBeNull();
    expect(decodeOAuth2LoginState('{"sourceId":1,"provider":"openidConnect"}')).toBeNull(); // expectedState missing
    expect(decodeOAuth2LoginState('{"sourceId":1,"expectedState":"s"}')).toBeNull(); // provider missing
    // Unknown members are ignored (forward-compat read), known ones typed.
    const decoded = decodeOAuth2LoginState(
      '{"sourceId":1,"provider":"openidConnect","expectedState":"s","continue":"signup","future":"ignored","continue-invalid":42}',
    );
    expect(decoded).toEqual({ sourceId: 1, provider: "openidConnect", expectedState: "s", continue: "signup" });
  });
});

describe("the dance cookie carrier", () => {
  const dance = (): OAuth2LoginState => ({ sourceId: 3, provider: "openidConnect", expectedState: "abc" });

  function cookieRequest(cookie: string): Request {
    return new Request("https://app.example.com/user/oauth2/OIDC", { headers: { cookie } });
  }

  it("set/clear wrap the encoded state with the session cookie's flag set + a dance-lifetime Max-Age", () => {
    const directive = oauth2DanceSetCookie(encodeOAuth2LoginState(dance()));
    expect(directive).toContain(`${OAUTH2_DANCE_COOKIE_NAME}=`);
    expect(directive).toContain("HttpOnly");
    expect(directive).toContain("Secure");
    expect(directive).toContain("SameSite=Lax");
    expect(directive).toContain("Max-Age=600");
    expect(oauth2DanceClearCookie()).toContain("Max-Age=0");
  });

  it("reads the first cookie value back through the same encoder (the round-trip)", () => {
    const request = cookieRequest(`other=1; ${OAUTH2_DANCE_COOKIE_NAME}=${encodeURIComponent(encodeOAuth2LoginState(dance()))}`);
    expect(decodeOAuth2LoginState(oauth2DanceCookieValue(request))).toEqual(dance());
  });

  it("absent, empty, and undecodable cookies answer null", () => {
    expect(oauth2DanceCookieValue(cookieRequest("a=b"))).toBeNull();
    expect(oauth2DanceCookieValue(new Request("https://x/"))).toBeNull();
    expect(oauth2DanceCookieValue(cookieRequest(`${OAUTH2_DANCE_COOKIE_NAME}=%ZZ`))).toBeNull();
  });
});

describe("timingSafeStateEqual (the §5.3.2 compare)", () => {
  it("equal strings match; length mismatches and differing bytes do not", () => {
    expect(timingSafeStateEqual("abc", "abc")).toBe(true);
    expect(timingSafeStateEqual("abc", "abd")).toBe(false);
    expect(timingSafeStateEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStateEqual("", "")).toBe(true);
  });
});

describe("the ladder — resolveByExternalLogin (§5.5.1 + the stale cleanup)", () => {
  it("a linked individual signs in — the join resolves the (sourceId, externalId) pair", async () => {
    const source = await seedSource();
    const userId = await seedUserRow({ name: "jane" });
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId, provider: "openidConnect", email: "jane@example.com" });

    const resolution = await resolveByExternalLogin(env.DB, source, profile());
    expect(resolution).toMatchObject({ outcome: "linked", user: { id: userId, username: "jane", type: "user" } });
    if (resolution.outcome === "linked") expect(resolution.link.email).toBe("jane@example.com");
  });

  it("a link to an ORG row is the stale arm: removed, ladder answers unlinked (oauth.go:520-541)", async () => {
    const source = await seedSource();
    const orgId = await seedUserRow({ name: "ghost-org", type: "org" });
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId: orgId, provider: "openidConnect" });
    expect(await getExternalLogin(env.DB, source.id, "sub-1")).not.toBeNull();

    const resolution = await resolveByExternalLogin(env.DB, source, profile());
    expect(resolution).toEqual({ outcome: "unlinked" });
    // The stale row is GONE — the next sign-in can relink.
    expect(await getExternalLogin(env.DB, source.id, "sub-1")).toBeNull();
    expect(await countLoginSourceUsers(env.DB, source.id)).toBe(0);
  });

  it("a link to a DELETED user cannot survive (the FK cascade is structural), and a plain miss is unlinked", async () => {
    const source = await seedSource();
    const userId = await seedUserRow({ name: "vanishing" });
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId, provider: "openidConnect" });
    await drizzle(env.DB).delete(users).where(eq(users.id, userId));

    // The cascade already removed the link — resolution is the plain miss.
    const resolution = await resolveByExternalLogin(env.DB, source, profile());
    expect(resolution).toEqual({ outcome: "unlinked" });
    expect(await getExternalLogin(env.DB, source.id, "sub-1")).toBeNull();
  });

  it("a prohibited individual still resolves — the mint-time posture refuses them (the route's arm)", async () => {
    const source = await seedSource();
    const userId = await seedUserRow({ name: "suspended", status: "prohibited" });
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId, provider: "openidConnect" });
    const resolution = await resolveByExternalLogin(env.DB, source, profile());
    expect(resolution).toMatchObject({ outcome: "linked", user: { status: "prohibited" } });
  });
});

describe("linkIdentityToUser (EnsureLinkExternalToUser via the W1 store op)", () => {
  it("inserts the bounded profile + the goth provider key; token columns stay ABSENT (§7.8)", async () => {
    const source = await seedSource();
    const userId = await seedUserRow({ name: "jane" });
    const link = await linkIdentityToUser(env.DB, source, userId, profile());
    expect(link).toMatchObject({
      externalId: "sub-1",
      loginSourceId: source.id,
      userId,
      provider: "openidConnect",
      email: "jane@example.com",
      firstName: "Jane",
    });
    expect(link.accessToken).toBeNull();
    expect(link.refreshToken).toBeNull();
    expect(link.expiresAt).toBeNull();
  });

  it("re-links REFRESH the profile in place (no duplicate rows)", async () => {
    const source = await seedSource();
    const userId = await seedUserRow({ name: "jane" });
    await linkIdentityToUser(env.DB, source, userId, profile());
    await linkIdentityToUser(env.DB, source, userId, profile("sub-1", { email: "moved@example.com", name: "Jane Q. Doe" }));
    expect(await countLoginSourceUsers(env.DB, source.id)).toBe(1);
    expect((await getExternalLogin(env.DB, source.id, "sub-1"))?.email).toBe("moved@example.com");
  });
});

describe("the pre-fill helpers (extractUserNameFromOAuth2's merged order, auth.go:434)", () => {
  it("suggestedUsername: preferred_username (sanitized) → email local-part → externalId", () => {
    expect(suggestedUsername(profile(), "Jane O'Neil")).toBe("Jane_O_Neil");
    expect(suggestedUsername(profile())).toBe("jane"); // preferred_username absent → email local-part
    expect(suggestedUsername(profile("sub-9", { email: null }))).toBe("sub-9");
    expect(suggestedUsername(profile("sub-9", { email: null }, ), "@@@")).toBe("sub-9"); // sanitized-to-empty hint falls through
  });

  it("sanitizeSuggestedUsername keeps username-safe characters, caps at 40", () => {
    expect(sanitizeSuggestedUsername("simple-name_1")).toBe("simple-name_1");
    expect(sanitizeSuggestedUsername("we!rd name")).toBe("we_rd_name");
    expect(sanitizeSuggestedUsername("--- leading")).toBe("leading");
    expect(sanitizeSuggestedUsername("a".repeat(100))).toHaveLength(40);
  });
});

describe("the init-window guard (§5.5.3's strengthening)", () => {
  it("refuses while NO human user row exists; a seeded human closes it", async () => {
    expect(await externalSignupBlockedByInitWindow(env.DB)).toBe(true);
    await seedUserRow({ name: "first-admin", status: "prohibited" }); // a prohibited system-ish row does NOT close it...
    expect(await externalSignupBlockedByInitWindow(env.DB)).toBe(true);
    const human = await seedUserRow({ name: "real-human", status: "active" });
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind("human@example.com", String(human)).run();
    expect(await externalSignupBlockedByInitWindow(env.DB)).toBe(false);
  });
});
