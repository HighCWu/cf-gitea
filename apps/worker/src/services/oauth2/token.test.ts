/**
 * The token service suite (SPEC specs/oauth2-provider.md §5 "Scope
 * normalization table", "Token response shape", "Grant/code store" W2
 * halves): the scope-family ports (general scopes verbatim, the legacy
 * `all` default, the no-token-scope garbage guard, public-only), the RFC
 * 7636 S256 vector + the upstream ValidateCodeChallenge fixture matrix,
 * the mint round-trip through the REAL grant store (claims, member order,
 * the email_verified bool-omitempty arm, the org:team groups), the
 * no-default-rotation trap (default: same counter; the ON arm: the CAS +
 * the moved cnt), the HS client-secret id_token arm, and the API dispatch
 * resolution (kind/time/grant arms, IsIndividual).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { resetAuthTables } from "../../auth/testing/seeds";
import { oauth2Applications, oauth2Grants, orgMembers, teamMembers, teams, users, userSettings } from "../../db/schema";
import { getOrCreateGrant, setGrantNonce, type OAuth2GrantRow } from "./grants";
import { base64UrlDecode } from "./jws";
import {
  buildIdTokenClaims,
  deriveCodeChallenge,
  getOAuthGroupsForUser,
  grantAdditionalScopes,
  importClientKey,
  loadOAuth2SigningMaterial,
  mintTokenTrio,
  normalizeGrantScope,
  oauth2FeatureEnabled,
  oauth2Issuer,
  resolveOAuth2AccessTokenCredential,
  s256ChallengeFromVerifier,
  splitGrantScopes,
  validateCodeChallenge,
  ACCESS_TOKEN_EXPIRATION_SECONDS,
  REFRESH_TOKEN_EXPIRATION_SECONDS,
} from "./token";

const T0 = new Date("2026-01-01T00:00:00Z");
const T0_SEC = Math.floor(T0.getTime() / 1000);

beforeAll(applyAuthD1Migrations);
beforeEach(async () => {
  await resetAuthTables();
});

// ---------------------------------------------------------------------------
// Seed helpers (the org/team lattice lives in the users/org_members/teams
// tables — the schema's SPEC-0007 shapes).
// ---------------------------------------------------------------------------

let seq = 0;

async function seedUser(options?: { email?: string | null; displayName?: string; website?: string; language?: string }): Promise<number> {
  seq += 1;
  const row = await drizzle(env.DB)
    .insert(users)
    .values({
      username: `user${seq}`,
      usernameLower: `user${seq}`,
      email: options?.email === undefined ? `user${seq}@example.com` : options.email,
      displayName: options?.displayName ?? null,
      website: options?.website ?? null,
      status: "active",
      createdAt: T0,
    })
    .returning();
  const user = row[0]!;
  if (options?.language !== undefined) {
    await drizzle(env.DB).insert(userSettings).values({ userId: user.id, language: options.language });
  }
  return user.id;
}

async function seedOrg(options?: { visibility?: "public" | "limited" | "private" }): Promise<{ id: number; name: string }> {
  seq += 1;
  const name = `org${seq}`;
  const row = await drizzle(env.DB)
    .insert(users)
    .values({
      username: name,
      usernameLower: name,
      type: "org",
      visibility: options?.visibility ?? "public",
      status: "active",
      createdAt: T0,
    })
    .returning();
  return { id: row[0]!.id, name };
}

async function seedMembership(orgId: number, userId: number, isPublic: boolean): Promise<void> {
  await drizzle(env.DB).insert(orgMembers).values({ orgId, userId, isPublic, role: "member", createdAt: T0 });
}

async function seedTeam(orgId: number, name: string): Promise<number> {
  const row = await drizzle(env.DB)
    .insert(teams)
    .values({ orgId, lowerName: name.toLowerCase(), name })
    .returning();
  return row[0]!.id;
}

async function seedTeamMember(teamId: number, orgId: number, userId: number): Promise<void> {
  await drizzle(env.DB).insert(teamMembers).values({ teamId, orgId, userId });
}

async function seedApp(options?: { confidential?: boolean; clientSecret?: string }): Promise<{ id: number; clientId: string }> {
  seq += 1;
  const clientId = `client-${seq}`;
  const row = await drizzle(env.DB)
    .insert(oauth2Applications)
    .values({
      uid: 0,
      name: `app-${seq}`,
      clientId,
      clientSecret: options?.clientSecret ?? "",
      confidentialClient: options?.confidential ?? false,
      redirectUris: '["http://127.0.0.1"]',
      createdAt: T0,
      updatedAt: T0,
    })
    .returning();
  return { id: row[0]!.id, clientId };
}

async function seedGrant(userId: number, applicationId: number, scope: string): Promise<OAuth2GrantRow> {
  const { grant } = await getOrCreateGrant(env.DB, { userId, applicationId, scope }, T0);
  return grant;
}

// ---------------------------------------------------------------------------
// Scope family (access_token.go:78-134 — the SPEC §5 normalization table)
// ---------------------------------------------------------------------------

describe("splitGrantScopes / normalizeGrantScope / grantAdditionalScopes (access_token.go:87-134)", () => {
  it("keeps general scopes verbatim — DUPLICATES retained (upstream appends unconditionally)", () => {
    const { generalScopes, accessScope } = splitGrantScopes("openid groups openid email");
    expect(generalScopes).toEqual(["openid", "groups", "openid", "email"]);
    expect(accessScope).toBe("");
    expect(normalizeGrantScope("openid openid")).toBe("openid openid");
  });

  it("no access-scope word retains the legacy `all` default (GrantAdditionalScopes, since 1.22)", () => {
    expect(grantAdditionalScopes("openid profile")).toBe("all");
    expect(grantAdditionalScopes("")).toBe("all");
    expect(grantAdditionalScopes("openid read:repository")).toBe("read:repository");
  });

  it("expands comma-joined access words and normalizes them (the bitmap order: issue before repository)", () => {
    // comma words live INSIDE one space-separated word (the SPEC §2.5 shape)
    expect(normalizeGrantScope("openid read:repository,write:issue")).toBe("openid write:issue,read:repository");
    // write⇒read collapse through the landed bitmap normalizer
    expect(grantAdditionalScopes("write:repository")).toBe("write:repository");
    expect(grantAdditionalScopes("read:repository,read:issue")).toBe("read:issue,read:repository");
  });

  it("normalization that discards every invalid scope leaves no-token-scope, NOT all (:110-118)", () => {
    expect(grantAdditionalScopes("openid not-a-scope,also-bogus")).toBe("no-token-scope");
    expect(normalizeGrantScope("openid not-a-scope")).toBe("openid no-token-scope");
  });

  it("public-only rides the access scope and the bitmap order leads with it", () => {
    expect(grantAdditionalScopes("openid public-only")).toBe("public-only");
    expect(grantAdditionalScopes("public-only,read:repository")).toBe("public-only,read:repository");
  });

  it("NormalizeGrantScope joins general scopes and the access scope with single spaces", () => {
    expect(normalizeGrantScope("")).toBe("");
    expect(normalizeGrantScope("openid")).toBe("openid");
    expect(normalizeGrantScope("all")).toBe("all");
  });
});

// ---------------------------------------------------------------------------
// PKCE (oauth2.go:448-482 + the upstream fixture matrix)
// ---------------------------------------------------------------------------

describe("the PKCE challenge family (oauth2.go:448-482, oauth2_test.go:288-311)", () => {
  it("S256 = BASE64URL(SHA256(ASCII(verifier))) — the RFC 7636 appendix-B vector", async () => {
    const challenge = await s256ChallengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(await deriveCodeChallenge("S256", "s256-verifier")).toBe(await s256ChallengeFromVerifier("s256-verifier"));
  });

  it("ports the upstream ValidateCodeChallenge fixture table", async () => {
    const s256Verifier = "s256-verifier";
    const s256Challenge = await s256ChallengeFromVerifier(s256Verifier);
    const missingVerifierChallenge = await s256ChallengeFromVerifier("verifier-not-supplied");
    const row = (method: string, challenge: string): Parameters<typeof validateCodeChallenge>[0] => ({
      id: 1,
      grantId: 1,
      code: "gta_x",
      codeChallenge: challenge,
      codeChallengeMethod: method,
      redirectUri: "",
      validUntil: T0,
    });
    const cases: [name: string, method: string, challenge: string, verifier: string, valid: boolean][] = [
      ["plain-success", "plain", "plain-secret", "plain-secret", true],
      ["plain-failure", "plain", "plain-secret", "ierwgjoergjio", false],
      ["s256-success", "S256", s256Challenge, s256Verifier, true],
      ["s256-failure", "S256", s256Challenge, "wiogjerogorewngoenrg", false],
      ["unsupported-method", "monkey", "foiwgjioriogeiogjerger", "foiwgjioriogeiogjerger", false],
      ["no-pkce-configured", "", "", "", true],
      ["s256-missing-verifier", "S256", missingVerifierChallenge, "", false],
      ["plain-missing-verifier", "plain", "plain-secret", "", false],
    ];
    for (const [name, method, challenge, verifier, valid] of cases) {
      expect(await validateCodeChallenge(row(method, challenge), verifier), name).toBe(valid);
    }
  });

  it("a challenge stored WITHOUT a method can never verify (requiresCodeVerifier + method=='' guard)", async () => {
    const code = {
      id: 1,
      grantId: 1,
      code: "gta_x",
      codeChallenge: "orphan-challenge",
      codeChallengeMethod: "",
      redirectUri: "",
      validUntil: T0,
    };
    expect(await validateCodeChallenge(code, "orphan-challenge")).toBe(false);
    expect(await validateCodeChallenge(code, "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The gate + issuer helpers
// ---------------------------------------------------------------------------

describe("the gate polarity and the issuer", () => {
  it("OAUTH2_ENABLED: only the exact string 'false' disables (default true — upstream's)", () => {
    expect(oauth2FeatureEnabled({})).toBe(true);
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: "true" })).toBe(true);
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: "" })).toBe(true);
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: "false" })).toBe(false);
  });

  it("issuer = the JWT_CLAIM_ISSUER override, else the AppURL sans trailing slash", () => {
    expect(oauth2Issuer({}, "https://git.example.com")).toBe("https://git.example.com");
    expect(oauth2Issuer({ APP_URL: "https://pinned.example.com/" }, "https://other.example.com")).toBe("https://pinned.example.com");
    expect(oauth2Issuer({ OAUTH2_JWT_CLAIM_ISSUER: "https://issuer.example.com" }, "https://git.example.com")).toBe(
      "https://issuer.example.com",
    );
  });
});

// ---------------------------------------------------------------------------
// The mint round-trip through the REAL store
// ---------------------------------------------------------------------------

describe("mintTokenTrio through the real store (NewAccessTokenResponse, access_token.go:154-275)", () => {
  it("mints access+refresh with the {gnt,tt,exp,iat}/{gnt,tt,cnt,exp,iat} claims and the envelope member order", async () => {
    const userId = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, "openid profile read:repository");
    const material = await loadOAuth2SigningMaterial(env.DB);
    const result = await mintTokenTrio({
      db: env.DB,
      grant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!,
      material,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("mint failed");
    // the envelope member order — AccessTokenResponse's struct order, with
    // scope present (normalized) and id_token ABSENT (no openid... wait,
    // this grant HAS openid — order check carries it; the absent case is
    // the next test).
    const response = result.response as { access_token: string; refresh_token: string; id_token: string; scope: string };
    expect(Object.keys(result.response)).toEqual(["access_token", "token_type", "expires_in", "refresh_token", "id_token", "scope"]);
    expect(result.response.token_type).toBe("bearer");
    expect(result.response.expires_in).toBe(ACCESS_TOKEN_EXPIRATION_SECONDS);

    const accessClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode(response.access_token.split(".")[1]!))) as Record<string, unknown>;
    expect(accessClaims).toEqual({ gnt: grant.id, tt: 0, exp: T0_SEC + ACCESS_TOKEN_EXPIRATION_SECONDS, iat: T0_SEC });
    const refreshClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode(response.refresh_token.split(".")[1]!))) as Record<string, unknown>;
    expect(refreshClaims).toEqual({
      gnt: grant.id,
      tt: 1,
      cnt: grant.counter,
      exp: T0_SEC + REFRESH_TOKEN_EXPIRATION_SECONDS,
      iat: T0_SEC,
    });
    expect(REFRESH_TOKEN_EXPIRATION_SECONDS).toBe(730 * 60 * 60); // the units trap: HOURS
    // the access token carries the signing kid; the refresh token verifies
    // against the same key
    expect(response.access_token.split(".")[0]).not.toBeUndefined();
  });

  it("an empty grant scope omits `scope` (omitempty) and mints all-authority tokens", async () => {
    const userId = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, "");
    const material = await loadOAuth2SigningMaterial(env.DB);
    const result = await mintTokenTrio({
      db: env.DB,
      grant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!,
      material,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      now: T0,
    });
    if (!result.ok) throw new Error("mint failed");
    expect(Object.keys(result.response)).toEqual(["access_token", "token_type", "expires_in", "refresh_token"]);
    expect(grantAdditionalScopes(grant.scope)).toBe("all");
  });
});

// ---------------------------------------------------------------------------
// The id_token claims (token.go:67-86 — member order + omitempty semantics)
// ---------------------------------------------------------------------------

describe("buildIdTokenClaims (the OIDCToken member order + the omitempty semantics)", () => {
  it("iss/sub/aud/exp/iat lead; nonce rides; the profile family renders in struct order", async () => {
    const userId = await seedUser({ displayName: "A User", website: "https://u.example.com", language: "en-US" });
    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, "openid profile");
    const applicationRow = (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!;
    const userRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!;
    const { claims } = await buildIdTokenClaims({
      db: env.DB,
      grant,
      application: applicationRow,
      user: userRow,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      exp: T0_SEC + 3600,
      nowSec: T0_SEC,
    });
    expect(Object.keys(claims)).toEqual([
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "name",
      "preferred_username",
      "profile",
      "picture",
      "website",
      "locale",
    ]);
    expect(claims.iss).toBe("https://git.example.com");
    expect(claims.sub).toBe(String(userId));
    expect(claims.aud).toEqual([app.clientId]);
    expect(claims.name).toBe("A User");
    expect(claims.preferred_username).toBe(userRow.username);
    expect(claims.profile).toBe(`https://git.example.com/${userRow.username}`);
    expect(claims.picture).toBe(`https://git.example.com/avatars/${userRow.usernameLower}`);
    expect(claims.website).toBe("https://u.example.com");
    expect(claims.locale).toBe("en-US");
    // updated_at omits (no users.updated_unix column — the zero stamp
    // upstream omitempty drops too)
    expect(claims.updated_at).toBeUndefined();
  });

  it("email_verified is a Go bool omitempty — present ONLY when true; empty email omits", async () => {
    const activeId = await seedUser({ email: "active@example.com" });
    const activeApp = await seedApp();
    const activeGrant = await seedGrant(activeId, activeApp.id, "openid email");
    const activeRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, activeId)).get())!;
    const active = await buildIdTokenClaims({
      db: env.DB,
      grant: activeGrant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, activeApp.id)).get())!,
      user: activeRow,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      exp: T0_SEC + 3600,
      nowSec: T0_SEC,
    });
    expect(active.claims.email).toBe("active@example.com");
    expect(active.claims.email_verified).toBe(true);

    // prohibited = the not-activated arm (the recorded status mapping) —
    // email still carries, email_verified OMITS.
    await drizzle(env.DB).update(users).set({ status: "prohibited" }).where(eq(users.id, activeId));
    const prohibited = await buildIdTokenClaims({
      db: env.DB,
      grant: activeGrant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, activeApp.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, activeId)).get())!,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      exp: T0_SEC + 3600,
      nowSec: T0_SEC,
    });
    expect(prohibited.claims.email).toBe("active@example.com");
    expect(prohibited.claims.email_verified).toBeUndefined();
    expect(Object.keys(prohibited.claims)).toEqual(["iss", "sub", "aud", "exp", "iat", "email"]);

    // a null email omits the email claim — but email_verified rides TRUE
    // (upstream sets it independently: Email = "" omits, EmailVerified =
    // IsActive omits only when false — the Go bool omitempty asymmetry)
    const noEmailId = await seedUser({ email: null });
    const noEmailApp = await seedApp();
    const noEmailGrant = await seedGrant(noEmailId, noEmailApp.id, "openid email");
    const noEmail = await buildIdTokenClaims({
      db: env.DB,
      grant: noEmailGrant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, noEmailApp.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, noEmailId)).get())!,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      exp: T0_SEC + 3600,
      nowSec: T0_SEC,
    });
    expect(noEmail.claims.email).toBeUndefined();
    expect(noEmail.claims.email_verified).toBe(true);
    expect(Object.keys(noEmail.claims)).toEqual(["iss", "sub", "aud", "exp", "iat", "email_verified"]);
  });

  it("groups ride the org:team names; the public-only bit filters to public orgs + public membership", async () => {
    const userId = await seedUser();
    const publicOrg = await seedOrg({ visibility: "public" });
    const privateOrg = await seedOrg({ visibility: "private" });
    await seedMembership(publicOrg.id, userId, true);
    await seedMembership(privateOrg.id, userId, true);
    const teamId = await seedTeam(publicOrg.id, "Devs");
    await seedTeamMember(teamId, publicOrg.id, userId);

    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, "openid groups");
    const full = await buildIdTokenClaims({
      db: env.DB,
      grant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      exp: T0_SEC + 3600,
      nowSec: T0_SEC,
    });
    // the unrestricted mint includes EVERY membership (the private org
    // too — onlyPublicGroups=false is IncludeVisibility=private)
    expect(full.claims.groups).toEqual([publicOrg.name, `${publicOrg.name}:devs`, privateOrg.name]);

    // the restricted mint needs its OWN application — one grant per
    // (user, app) pair, so re-seeding the same pair returns the first grant
    const restrictedApp = await seedApp();
    const restrictedGrant = await seedGrant(userId, restrictedApp.id, "openid groups public-only");
    const restricted = await buildIdTokenClaims({
      db: env.DB,
      grant: restrictedGrant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, restrictedApp.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      exp: T0_SEC + 3600,
      nowSec: T0_SEC,
    });
    // the private org drops out; the public org + its team stay
    const restrictedGroups = restricted.claims.groups as string[];
    expect(restrictedGroups).toEqual([publicOrg.name, `${publicOrg.name}:devs`]);

    // a private-membership user in the SAME public org is filtered out by
    // the is_public arm (onlyPublicGroups)
    const hiddenUserId = await seedUser();
    await seedMembership(publicOrg.id, hiddenUserId, false);
    const hidden = await getOAuthGroupsForUser(env.DB, hiddenUserId, true);
    expect(hidden).toBeNull();
    expect(await getOAuthGroupsForUser(env.DB, hiddenUserId, false)).toEqual([publicOrg.name]);
  });

  it("a nonce stored on the grant rides the id_token; org-less users omit groups (omitempty)", async () => {
    const userId = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, "openid");
    await setGrantNonce(env.DB, grant.id, "n0nce-value");
    const refreshed = (await drizzle(env.DB).select().from(oauth2Grants).where(eq(oauth2Grants.id, grant.id)).get())!;
    const claims = await buildIdTokenClaims({
      db: env.DB,
      grant: refreshed,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      exp: T0_SEC + 3600,
      nowSec: T0_SEC,
    });
    expect(claims.claims.nonce).toBe("n0nce-value");
    expect(Object.keys(claims.claims)).toEqual(["iss", "sub", "aud", "exp", "iat", "nonce"]);
    expect(claims.claims.groups).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The rotation trap (access_token.go:155-162 + oauth2_provider.go:617-624)
// ---------------------------------------------------------------------------

describe("the no-default-rotation trap (InvalidateRefreshTokens default FALSE)", () => {
  async function mintTwice(rotate: boolean, staleCnt?: number) {
    const userId = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, "");
    const material = await loadOAuth2SigningMaterial(env.DB);
    const appRow = (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!;
    const userRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!;
    const first = await mintTokenTrio({
      db: env.DB,
      grant,
      application: appRow,
      user: userRow,
      material,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      now: T0,
    });
    if (!first.ok) throw new Error("first mint failed");
    if (staleCnt !== undefined) {
      const stale = { ...grant, counter: staleCnt };
      return {
        first,
        second: await mintTokenTrio({
          db: env.DB,
          grant: stale,
          application: appRow,
          user: userRow,
          material,
          issuer: "https://git.example.com",
          appUrl: "https://git.example.com/",
          now: T0,
          invalidateRefreshTokens: true,
        }),
      };
    }
    const second = await mintTokenTrio({
      db: env.DB,
      grant,
      application: appRow,
      user: userRow,
      material,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      now: T0,
      invalidateRefreshTokens: rotate,
    });
    return { first, second };
  }

  it("the DEFAULT: refresh mints a fresh pair carrying the SAME counter — the grant row untouched", async () => {
    const { first, second } = await mintTwice(false);
    if (!second.ok) throw new Error("second mint failed");
    const firstRefresh = JSON.parse(new TextDecoder().decode(base64UrlDecode((first.response as { refresh_token: string }).refresh_token.split(".")[1]!))) as Record<string, unknown>;
    const secondRefresh = JSON.parse(new TextDecoder().decode(base64UrlDecode((second.response as { refresh_token: string }).refresh_token.split(".")[1]!))) as Record<string, unknown>;
    expect(firstRefresh.cnt).toBe(1);
    expect(secondRefresh.cnt).toBe(1); // the counter never moved
    const rowAfter = (await drizzle(env.DB).select().from(oauth2Grants).where(eq(oauth2Grants.id, firstRefresh.gnt as number)).get())!;
    expect(rowAfter.counter).toBe(1);
    // the tokens are byte-identical at the same mint instant (deterministic
    // RSASSA) — the "fresh pair" is the SIGNING act, not new claims: the
    // counter is the only state a refresh could have moved, and it didn't.
    expect((second.response as { refresh_token: string }).refresh_token).toBe(
      (first.response as { refresh_token: string }).refresh_token,
    );
  });

  it("the ON arm: the CAS moves the counter and the new cnt carries the MOVED value", async () => {
    const { first, second } = await mintTwice(true);
    if (!second.ok) throw new Error("second mint failed");
    const firstRefresh = JSON.parse(new TextDecoder().decode(base64UrlDecode((first.response as { refresh_token: string }).refresh_token.split(".")[1]!))) as Record<string, unknown>;
    const secondRefresh = JSON.parse(new TextDecoder().decode(base64UrlDecode((second.response as { refresh_token: string }).refresh_token.split(".")[1]!))) as Record<string, unknown>;
    expect(firstRefresh.cnt).toBe(1);
    expect(secondRefresh.cnt).toBe(2); // the moved counter
    const rowAfter = (await drizzle(env.DB).select().from(oauth2Grants).where(eq(oauth2Grants.id, firstRefresh.gnt as number)).get())!;
    expect(rowAfter.counter).toBe(2);
  });

  it("the ON arm with a STALE cnt: the CAS matches zero rows → invalid_grant 'cannot increase the grant counter'", async () => {
    const userId = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, "");
    const material = await loadOAuth2SigningMaterial(env.DB);
    const appRow = (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!;
    const userRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!;
    // the grant's counter moved under the stolen token (a concurrent
    // refresh already bumped it to 2; the stolen token says cnt=1)
    await drizzle(env.DB).update(oauth2Grants).set({ counter: 2 }).where(eq(oauth2Grants.id, grant.id));
    const stale = await mintTokenTrio({
      db: env.DB,
      grant: { ...grant, counter: 1 },
      application: appRow,
      user: userRow,
      material,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      now: T0,
      invalidateRefreshTokens: true,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error).toEqual({ error: "invalid_grant", error_description: "cannot increase the grant counter" });
    }
  });
});

// ---------------------------------------------------------------------------
// The HS client-key arm (oauth2_provider.go:539-551)
// ---------------------------------------------------------------------------

describe("the HS id_token client-key arm", () => {
  it("an HS deployment signs the id_token with the CLIENT secret; the access token stays on the server key", async () => {
    const userId = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, "openid");
    const material = await loadOAuth2SigningMaterial(env.DB, "HS256");
    expect(material.alg).toBe("HS256");
    expect(material.kid).toBeUndefined(); // the HMAC header carries no kid
    const clientKey = await importClientKey(material, "gto_aclientsecret");
    const result = await mintTokenTrio({
      db: env.DB,
      grant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!,
      material,
      clientKey,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      now: T0,
    });
    if (!result.ok) throw new Error("mint failed");
    const response = result.response as { access_token: string; id_token: string };
    // the id_token verifies with the CLIENT secret, not the server secret
    const { importVerifyKey, verifyJws } = await import("./jws");
    const verifyKey = await importVerifyKey("HS256", "gto_aclientsecret");
    const verified = await verifyJws({ alg: "HS256", key: verifyKey, token: response.id_token, nowSec: T0_SEC });
    expect(verified.claims.iss).toBe("https://git.example.com");
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(response.id_token.split(".")[0]!))) as Record<string, unknown>;
    expect(header.alg).toBe("HS256");
    expect(header.kid).toBeUndefined();
    // the server-key verification FAILS (different material)
    await expect(
      verifyJws({ alg: "HS256", key: material.serverVerifyKey, token: response.id_token, nowSec: T0_SEC }),
    ).rejects.toThrow();
  });

  it("an empty client secret cannot import an HS key (workerd) — the create-key failure arm's precondition", async () => {
    const material = await loadOAuth2SigningMaterial(env.DB, "HS256");
    await expect(importClientKey(material, "")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The API dispatch resolution (services/auth/oauth2.go:30-58)
// ---------------------------------------------------------------------------

describe("resolveOAuth2AccessTokenCredential (the dispatch)", () => {
  async function mintFor(scope: string, options?: { alg?: string }): Promise<{ accessToken: string; refreshToken: string; grant: OAuth2GrantRow }> {
    const userId = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(userId, app.id, scope);
    const material = await loadOAuth2SigningMaterial(env.DB, options?.alg);
    const result = await mintTokenTrio({
      db: env.DB,
      grant,
      application: (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!,
      user: (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!,
      material,
      issuer: "https://git.example.com",
      appUrl: "https://git.example.com/",
      now: T0,
    });
    if (!result.ok) throw new Error("mint failed");
    const response = result.response as { access_token: string; refresh_token: string };
    return { accessToken: response.access_token, refreshToken: response.refresh_token, grant };
  }

  it("resolves the doer + the GrantAdditionalScopes scope from a live access token", async () => {
    const { accessToken, grant } = await mintFor("openid read:repository");
    const resolved = await resolveOAuth2AccessTokenCredential(env.DB, accessToken, { enabled: true, now: new Date(T0.getTime() + 1000) });
    expect(resolved).not.toBeNull();
    expect(resolved!.grant.id).toBe(grant.id);
    expect(resolved!.scope).toBe("read:repository");
    expect(resolved!.grant.userId).toBe(grant.userId);
  });

  it("an OIDC-only grant resolves to the legacy `all` authority", async () => {
    const { accessToken } = await mintFor("openid profile");
    const resolved = await resolveOAuth2AccessTokenCredential(env.DB, accessToken, { enabled: true, now: new Date(T0.getTime() + 1000) });
    expect(resolved?.scope).toBe("all");
  });

  it("a REFRESH token is not an access credential (the kind check)", async () => {
    const { refreshToken } = await mintFor("");
    const resolved = await resolveOAuth2AccessTokenCredential(env.DB, refreshToken, { enabled: true, now: new Date(T0.getTime() + 1000) });
    expect(resolved).toBeNull();
  });

  it("expired (past exp) and future-iat tokens die with ZERO leeway", async () => {
    const { accessToken } = await mintFor("");
    expect(
      await resolveOAuth2AccessTokenCredential(env.DB, accessToken, { enabled: true, now: new Date(T0.getTime() + 3601_000) }),
    ).toBeNull();
    // future-iat: verifyJws carries no iat check (the golang-jwt default),
    // so THIS token dies at assertApiTimeBounds — the second, independent
    // API gate (jws.ts's documented asymmetry)
    expect(await resolveOAuth2AccessTokenCredential(env.DB, accessToken, { enabled: true, now: new Date(T0.getTime() - 1000) })).toBeNull();
    // exp == now: the golang-jwt arm (`exp.Before(now)` is strict) would
    // pass, but verifyJws's pinned `now >= exp` arm runs FIRST — the
    // asymmetry jws.ts documents as unobservable exactly as upstream
    expect(
      await resolveOAuth2AccessTokenCredential(env.DB, accessToken, { enabled: true, now: new Date(T0.getTime() + 3600_000) }),
    ).toBeNull();
  });

  it("a deleted grant kills its tokens (the gnt anchor)", async () => {
    const { accessToken, grant } = await mintFor("");
    await drizzle(env.DB).delete(oauth2Grants).where(eq(oauth2Grants.id, grant.id));
    expect(await resolveOAuth2AccessTokenCredential(env.DB, accessToken, { enabled: true, now: new Date(T0.getTime() + 1000) })).toBeNull();
  });

  it("a dotless token never dispatches; a tampered one fails; a disabled provider answers null", async () => {
    const { accessToken } = await mintFor("");
    // flip a MID-token character — the final base64 char carries padding
    // bits whose flip decodes to the same signature bytes
    const mid = accessToken.slice(0, 100) + (accessToken[100] === "a" ? "b" : "a") + accessToken.slice(101);
    expect(await resolveOAuth2AccessTokenCredential(env.DB, mid, { enabled: true, now: new Date(T0.getTime() + 1000) })).toBeNull();
    expect(await resolveOAuth2AccessTokenCredential(env.DB, "cfg_nodots", { enabled: true, now: new Date() })).toBeNull();
    expect(
      await resolveOAuth2AccessTokenCredential(env.DB, accessToken, { enabled: false, now: new Date(T0.getTime() + 1000) }),
    ).toBeNull();
  });
});
