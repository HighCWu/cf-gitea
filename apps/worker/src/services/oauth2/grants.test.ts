/**
 * The grant/code store suite (SPEC specs/oauth2-provider.md §5 "Grant/code
 * store"): create idempotence on the UNIQUE pair, the column-scoped scope/
 * nonce updates (updated_unix NOT bumped — the Cols parity), the
 * compare-and-increment counter with its zero-rows stale signal, the
 * one-time DELETE-rowcount consumption (the replay arm), the 10-minute
 * window boundary, the `gta_` code format, the PKCE field round-trip, the
 * joined grants list + owner-scoped revoke, and the application→grant→code
 * FK cascade.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { oauth2Applications } from "../../db/schema";
import { drizzle } from "drizzle-orm/d1";
import {
  consumeAuthorizationCode,
  ErrOAuth2AuthorizationCodeInvalidated,
  ErrOAuth2GrantStaleCounter,
  generateAuthorizationCode,
  generateAuthorizationCodeValue,
  getAuthorizationByCode,
  getGrantByID,
  getGrantByUserID,
  getOrCreateGrant,
  grantScopeContains,
  increaseGrantCounter,
  isAuthorizationCodeExpired,
  listGrantsByUserID,
  revokeGrant,
  setGrantNonce,
  updateGrantScope,
} from "./grants";

const T0 = new Date("2026-01-01T00:00:00Z");
const T0_PLUS_600 = new Date(T0.getTime() + 600_000);

/** The builtin-application rows exactly as MIGRATION 0052 seeded them —
 *  captured in beforeAll, before the suite's per-test wipes. */
interface SeededBuiltin {
  client_id: string;
  name: string;
  confidential_client: number;
  uid: number;
  redirect_uris: string;
}
let seededBuiltins: SeededBuiltin[] = [];

beforeAll(async () => {
  await applyAuthD1Migrations();
  const result = await env.DB.prepare(
    "SELECT client_id, name, confidential_client, uid, redirect_uris FROM oauth2_application WHERE client_id IN (?, ?, ?, ?, ?)",
  )
    .bind(
      "a4792ccc-144e-407e-86c9-5e7d8d9c3269",
      "e90ee53c-94e2-48ac-9358-a874fb9e0662",
      "d57cb8c4-630c-4168-8324-ec79935e18d4",
      "b757811a-05c8-4c76-8d74-a5ee3d2073f2",
      "75a9ec3e-42b5-40cb-9144-9ea96ecd56a6",
    )
    .all<SeededBuiltin>();
  seededBuiltins = result.results;
});

beforeEach(async () => {
  // FK order: codes → grants → applications (the cascade would handle the
  // first two, but plain deletes keep the reset explicit).
  await env.DB.prepare("DELETE FROM oauth2_authorization_code").run();
  await env.DB.prepare("DELETE FROM oauth2_grant").run();
  await env.DB.prepare("DELETE FROM oauth2_application").run();
});

describe("the builtin-application seed (migration 0052's INSERT OR IGNORE — oauth2.go:68-101)", () => {
  it("seeded exactly the five fixed-client native apps (uid 0, public, no secret)", () => {
    expect(seededBuiltins).toHaveLength(5);
    const byClient = new Map(seededBuiltins.map((row) => [row.client_id, row]));
    const expectBuiltin = (clientId: string, name: string, redirectUris: string): void => {
      const row = byClient.get(clientId);
      expect(row, clientId).toBeDefined();
      expect(row!.name).toBe(name);
      expect(row!.uid).toBe(0);
      expect(row!.confidential_client).toBe(0); // RFC 8252 native apps
      expect(JSON.parse(row!.redirect_uris)).toEqual(JSON.parse(redirectUris));
    };
    expectBuiltin("a4792ccc-144e-407e-86c9-5e7d8d9c3269", "git-credential-oauth", '["http://127.0.0.1","https://127.0.0.1"]');
    expectBuiltin("e90ee53c-94e2-48ac-9358-a874fb9e0662", "Git Credential Manager", '["http://127.0.0.1","https://127.0.0.1"]');
    expectBuiltin("d57cb8c4-630c-4168-8324-ec79935e18d4", "tea", '["http://127.0.0.1","https://127.0.0.1"]');
    expectBuiltin("b757811a-05c8-4c76-8d74-a5ee3d2073f2", "Gitea App", '["com.gitea.app://oauth/callback"]');
    expectBuiltin(
      "75a9ec3e-42b5-40cb-9144-9ea96ecd56a6",
      "gitea-vscode",
      '["http://127.0.0.1","https://127.0.0.1","vscode://gitea.gitea-for-vscode/auth/callback","vscode-insiders://gitea.gitea-for-vscode/auth/callback"]',
    );
  });
});

let applicationSeq = 0;

async function insertApplication(): Promise<{ id: number; name: string }> {  applicationSeq += 1;
  const name = `app-${applicationSeq}`;
  const row = await drizzle(env.DB)
    .insert(oauth2Applications)
    .values({
      uid: 0,
      name,
      clientId: crypto.randomUUID(),
      clientSecret: "",
      confidentialClient: false,
      redirectUris: '["http://127.0.0.1"]',
      createdAt: T0,
      updatedAt: T0,
    })
    .returning();
  return { id: row[0]!.id, name };
}

describe("grant create/read (oauth2.go:236-261)", () => {
  it("creates a grant with the upstream column defaults (counter 1, empty scope/nonce)", async () => {
    const appIdRow = await insertApplication();
    const { grant, created } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "openid" }, T0);
    expect(created).toBe(true);
    expect(grant.counter).toBe(1);
    expect(grant.scope).toBe("openid");
    expect(grant.nonce).toBe("");
    expect(grant.createdAt).toEqual(T0);
    expect(grant.updatedAt).toEqual(T0);
  });

  it("is idempotent on the UNIQUE pair: the second consent reads the same row", async () => {
    const appIdRow = await insertApplication();
    const first = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "openid" }, T0);
    const second = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "openid profile" }, new Date(T0.getTime() + 60_000));
    expect(second.created).toBe(false);
    expect(second.grant.id).toBe(first.grant.id);
    expect(second.grant.scope).toBe("openid"); // re-consent UPDATES scope in place, a second row is never made
    const all = await listGrantsByUserID(env.DB, 5);
    expect(all).toHaveLength(1);
  });

  it("keeps separate grants per user and per application (the pair is the key)", async () => {
    const appARow = await insertApplication();
    const appBRow = await insertApplication();
    await getOrCreateGrant(env.DB, { userId: 1, applicationId: appARow.id, scope: "" }, T0);
    await getOrCreateGrant(env.DB, { userId: 2, applicationId: appARow.id, scope: "" }, T0);
    await getOrCreateGrant(env.DB, { userId: 1, applicationId: appBRow.id, scope: "" }, T0);
    expect(await getGrantByUserID(env.DB, 1, appARow.id)).not.toBeNull();
    expect(await getGrantByUserID(env.DB, 2, appARow.id)).not.toBeNull();
    expect(await getGrantByUserID(env.DB, 1, appBRow.id)).not.toBeNull();
    expect(await getGrantByUserID(env.DB, 2, appBRow.id)).toBeNull();
  });

  it("getGrantByID answers null for a missing grant (the deleted-authority arm)", async () => {
    expect(await getGrantByID(env.DB, 424242)).toBeNull();
  });
});

describe("the column-scoped updates (oauth2.go:567-579 — updated_unix untouched)", () => {
  it("updateGrantScope writes ONLY the scope column", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "openid" }, T0);
    await updateGrantScope(env.DB, grant.id, "openid profile read:repository");
    const after = (await getGrantByID(env.DB, grant.id))!;
    expect(after.scope).toBe("openid profile read:repository");
    expect(after.nonce).toBe("");
    expect(after.counter).toBe(1);
    expect(after.updatedAt).toEqual(T0); // upstream Cols("scope") never bumps the auto-time column
  });

  it("setGrantNonce writes ONLY the nonce column", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "openid" }, T0);
    await setGrantNonce(env.DB, grant.id, "n-0ache-zzz");
    const after = (await getGrantByID(env.DB, grant.id))!;
    expect(after.nonce).toBe("n-0ache-zzz");
    expect(after.scope).toBe("openid");
    expect(after.updatedAt).toEqual(T0);
  });
});

describe("increaseGrantCounter (oauth2.go:545-559 — the compare-and-increment)", () => {
  it("moves counter seen → seen+1 and rejects a stale seen with the stale-counter error", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "" }, T0);
    await increaseGrantCounter(env.DB, grant.id, 1);
    expect((await getGrantByID(env.DB, grant.id))!.counter).toBe(2);
    // A stolen refresh token's cnt=1 vs the grant's counter=2 → zero rows.
    await expect(increaseGrantCounter(env.DB, grant.id, 1)).rejects.toBeInstanceOf(ErrOAuth2GrantStaleCounter);
    expect((await getGrantByID(env.DB, grant.id))!.counter).toBe(2); // the failed CAS moved nothing
  });
});

describe("list + revoke (oauth2.go:594-620)", () => {
  it("lists the user's grants INNER JOINed with their applications", async () => {
    const app = await insertApplication();
    await getOrCreateGrant(env.DB, { userId: 9, applicationId: app.id, scope: "openid" }, T0);
    const rows = await listGrantsByUserID(env.DB, 9);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grant.userId).toBe(9);
    expect(rows[0]!.application.id).toBe(app.id);
    expect(rows[0]!.application.name).toBe(app.name);
  });

  it("revokeGrant deletes only the owner's grant and cascades the codes", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 9, applicationId: appIdRow.id, scope: "" }, T0);
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "", codeChallenge: "", codeChallengeMethod: "" }, T0);
    expect(await revokeGrant(env.DB, grant.id, 8)).toBe(false); // not the owner
    expect(await getAuthorizationByCode(env.DB, code.code)).not.toBeNull();
    expect(await revokeGrant(env.DB, grant.id, 9)).toBe(true);
    expect(await getGrantByID(env.DB, grant.id)).toBeNull();
    expect(await getAuthorizationByCode(env.DB, code.code)).toBeNull(); // the FK cascade
  });
});

describe("grantScopeContains (oauth2.go:562-564 — exact-word membership)", () => {
  it("matches whole words only", () => {
    expect(grantScopeContains("openid profile", "openid")).toBe(true);
    expect(grantScopeContains("openid profile", "open")).toBe(false);
    expect(grantScopeContains("read:repository write:issue", "write:issue")).toBe(true);
    expect(grantScopeContains("", "openid")).toBe(false);
  });
});

describe("the `gta_` code format (oauth2.go:522-542)", () => {
  it("spells gta_ + 52 chars of lowercased unpadded base32 over 32 random bytes", () => {
    for (let i = 0; i < 20; i++) {
      const value = generateAuthorizationCodeValue();
      expect(value).toMatch(/^gta_[a-z2-7]{52}$/);
    }
  });

  it("is crypto-random: two calls never collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(generateAuthorizationCodeValue());
    }
    expect(seen.size).toBe(50);
  });
});

describe("generateAuthorizationCode + the 10-minute window (oauth2.go:31, §4.1.2)", () => {
  it("stamps valid_until = now + 600s exactly and round-trips the PKCE + redirect fields", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "" }, T0);
    const code = await generateAuthorizationCode(
      env.DB,
      {
        grantId: grant.id,
        redirectUri: "http://127.0.0.1/callback",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        codeChallengeMethod: "S256",
      },
      T0,
    );
    expect(code.validUntil).toEqual(T0_PLUS_600);
    expect(code.redirectUri).toBe("http://127.0.0.1/callback");
    expect(code.codeChallenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(code.codeChallengeMethod).toBe("S256");
    expect(code.code.startsWith("gta_")).toBe(true);
    const loaded = await getAuthorizationByCode(env.DB, code.code);
    expect(loaded).not.toBeNull();
    expect(loaded!.grant.id).toBe(grant.id);
    expect(loaded!.code.codeChallengeMethod).toBe("S256"); // the PKCE round-trip
  });

  it("a plain (no-PKCE) code carries empty challenge/method", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "" }, T0);
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://a", codeChallenge: "", codeChallengeMethod: "" }, T0);
    expect(code.codeChallenge).toBe("");
    expect(code.codeChallengeMethod).toBe("");
  });

  it("answers null for an unknown code (the vanished-grant arm is unreachable — the FK cascade)", async () => {
    expect(await getAuthorizationByCode(env.DB, "gta_nope")).toBeNull();
  });

  it("isAuthorizationCodeExpired pins the boundary: valid_until <= now dies, now-1 lives, zero dies", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "" }, T0);
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "", codeChallenge: "", codeChallengeMethod: "" }, T0);
    expect(isAuthorizationCodeExpired(code, new Date(T0_PLUS_600.getTime() - 1000))).toBe(false);
    expect(isAuthorizationCodeExpired(code, T0_PLUS_600)).toBe(true); // <= — one second past dies
    expect(isAuthorizationCodeExpired({ ...code, validUntil: new Date(0) }, T0)).toBe(true);
  });
});

describe("consumeAuthorizationCode — the one-time DELETE rowcount (oauth2.go:443-452)", () => {
  it("deletes the row once; the second presentation is the replay signal", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "" }, T0);
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "", codeChallenge: "", codeChallengeMethod: "" }, T0);
    // First redemption: the DELETE affects 1 row — success.
    await expect(consumeAuthorizationCode(env.DB, code.id)).resolves.toBeUndefined();
    expect(await getAuthorizationByCode(env.DB, code.code)).toBeNull();
    // Replay: zero affected rows ⇒ ErrOAuth2AuthorizationCodeInvalidated
    // (invalid_grant "authorization code already used" at the endpoint).
    await expect(consumeAuthorizationCode(env.DB, code.id)).rejects.toBeInstanceOf(ErrOAuth2AuthorizationCodeInvalidated);
    await expect(consumeAuthorizationCode(env.DB, 987654)).rejects.toBeInstanceOf(ErrOAuth2AuthorizationCodeInvalidated);
  });

  it("an expired code still consumes (the endpoint's invalidate-on-discovery arm rides the same DELETE)", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "" }, T0);
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "", codeChallenge: "", codeChallengeMethod: "" }, T0);
    const nowPast = new Date(T0_PLUS_600.getTime() + 1000);
    expect(isAuthorizationCodeExpired(code, nowPast)).toBe(true);
    await expect(consumeAuthorizationCode(env.DB, code.id)).resolves.toBeUndefined();
  });
});

describe("the application → grant → code FK cascade (SPEC §3 decision)", () => {
  it("deleting the application cascades its grants and their codes", async () => {
    const appIdRow = await insertApplication();
    const { grant } = await getOrCreateGrant(env.DB, { userId: 5, applicationId: appIdRow.id, scope: "" }, T0);
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "", codeChallenge: "", codeChallengeMethod: "" }, T0);
    await env.DB.prepare("DELETE FROM oauth2_application WHERE id = ?").bind(appIdRow.id).run();
    expect(await getGrantByID(env.DB, grant.id)).toBeNull();
    expect(await getAuthorizationByCode(env.DB, code.code)).toBeNull();
  });
});
