/**
 * authorizeGitHttp's PASSWORD arms at the HTTP seam (SPEC-0002 §6.2
 * git-HTTPS row) — the real worker pipeline over SELF (the gate.test.ts
 * posture; that file owns the token-arm matrix, this one closes the password
 * seam it leaves open). The password-Basic credential arrives, the token
 * arms miss (verified === null), and basicPasswordArm decides — upstream
 * services/auth/basic.go:135-161 running in the git routes' auth chain
 * (githttp.go:146-178).
 *
 * Wire shapes asserted byte-exact against the pin:
 *   - failed credential → the SAME 401 challenge site as the anonymous arm
 *     (githttp.go:146-159: WWW-Authenticate + HTTPError → http.Error's
 *     trailing newline) — realm follows the OAuth2 switch (default on ⇒
 *     `Basic realm="Gitea"`);
 *   - TOTP-enrolled password-Basic doer on a NOT-anonymously-readable read →
 *     plain-text 401, upstream's message VERBATIM (githttp.go:172 — its own
 *     TODO admits the body should become "invalid credentials"; we carry the
 *     pinned text as-is, acl.ts GIT_TOTP_PLAINTEXT_401);
 *   - the anon-allowed-read exemption: the TOTP gate lives INSIDE the
 *     !canAnonymousPull branch (githttp.go:132 → :160-172), so a read
 *     anonymous callers can make skips it — and REQUIRE_SIGNIN_VIEW
 *     (api/config.ts requireSignInViewEnabled, the census B-34/B-WAVE1 flag)
 *     kills canAnonymousPull, closing the exemption;
 *   - WebAuthn-enrolled folds into the generic challenge (identity never
 *     establishes — the !IsSigned arm, githttp.go:146-159; upstream's
 *     basic.go:155 ErrUserAuthMessage has NO API envelope on the git routes).
 */

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { totpCode } from "../auth/totp";
import { applyTwofaEnrollment, generateTotpSecret, mintPendingTicket } from "../auth/two-factor";
import { newPasswordRecord } from "../auth/password";
import { createCredential } from "../web/webauthn-store";
import { encodeCoseKey } from "../web/webauthn-ceremony";
import { RepoService } from "../repos/service";
import { auditEvents, authFailures, userSettingsKv, users } from "../db/schema";
import { GIT_TOTP_PLAINTEXT_401 } from "./acl";
import { requireSignInViewEnabled } from "../api/config";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // Dependents first (the gate.test.ts sweep order — repo_counters and the
  // service-seeded dependent tables declare FKs on repositories/users).
  for (const table of [
    "team_repo_access",
    "team_members",
    "teams",
    "deploy_keys",
    "repo_units",
    "repo_transfer",
    "repo_redirects",
    "repo_counters",
    "webhook_deliveries",
    "webhooks",
    "email_addresses",
    "sessions",
    "personal_access_tokens",
    "auth_failures",
    "user_settings_kv", // the OTP lock ladder writes the attempt counter (c54ec52f0f)
    "two_factor",
    "webauthn_credentials",
    "audit_event",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

// The REQUIRE_SIGNIN_VIEW var rides the test env (the vitest plugin injects
// wrangler VARS; the example pins it "false" — the GENERATED Env type carries
// that literal, so the widened runtime shape is the cast). The flag postures
// below flip it per-test and restore — strict polarity (api/config.ts:61-63).
const requireSignInViewEnv = env as Omit<Env, "REQUIRE_SIGNIN_VIEW"> & { REQUIRE_SIGNIN_VIEW?: string };
afterEach(() => {
  requireSignInViewEnv.REQUIRE_SIGNIN_VIEW = "false";
});

// upstream githttp.go:152-158's OAuth2-switched challenge — provider enabled
// by default (the gate.test.ts CHALLENGE comment carries the full history).
const CHALLENGE = 'Basic realm="Gitea"';
/** The failed/anonymous 401 BODY — `http.Error` appends the newline
 *  (services/context/base.go:105-111). */
const UNAUTHORIZED_BODY = "Unauthorized\n";

/** The upstream literal at the pin, self-checked (githttp.go:172). */
const UPSTREAM_TOTP_PLAINTEXT =
  "Users with two-factor authentication enabled cannot perform HTTP/HTTPS operations via plain username and password. Please create and use a personal access token on the user settings page";
if (GIT_TOTP_PLAINTEXT_401 !== UPSTREAM_TOTP_PLAINTEXT) {
  throw new Error("the repo-layer TOTP 401 body drifted from githttp.go:172");
}

// --- fixtures ----------------------------------------------------------------

function repoService(): RepoService {
  return new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") });
}

async function seedUserWithPassword(username: string, password = "correct horse battery staple"): Promise<{ id: number; password: string }> {
  const user = await seedVerifiedUser({ username });
  const record = await newPasswordRecord(password);
  const updated = await drizzle(env.DB)
    .update(users)
    .set({ passwd: record.passwd, salt: record.salt, passwdHashAlgo: record.passwdHashAlgo })
    .where(eq(users.id, user.id))
    .returning({ id: users.id })
    .all();
  if (updated.length === 0) throw new Error("password seed failed");
  return { id: user.id, password };
}

/** A live TOTP enrollment through the REAL enrollment seam (session.test.ts's
 *  seedEnrolled shape). */
async function seedTotp(userId: number): Promise<{ secret: string }> {
  const secret = generateTotpSecret();
  const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret });
  const outcome = await applyTwofaEnrollment(env.DB, userId, await totpCode(secret, Date.now() / 1000), ticket);
  if (outcome.outcome !== "enrolled") throw new Error(`enroll fixture failed: ${outcome.outcome}`);
  return { secret };
}

async function seedWebAuthn(userId: number): Promise<void> {
  const x = crypto.getRandomValues(new Uint8Array(32));
  const y = crypto.getRandomValues(new Uint8Array(32));
  await createCredential(env.DB, userId, "security key", {
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    coseKey: { kty: "EC2", x, y },
    publicKeyRaw: encodeCoseKey({ kty: "EC2", x, y }),
    attestationType: "none",
    aaguid: new Uint8Array(16),
    signCount: 0,
    transports: null,
    userPresent: true,
    userVerified: true,
  });
}

const infoRefs = async (owner: string, slug: string, service: "git-upload-pack" | "git-receive-pack", headers?: Record<string, string>): Promise<Response> =>
  await SELF.fetch(`https://example.com/${owner}/${slug}.git/info/refs?service=${service}`, {
    headers,
  });

// -----------------------------------------------------------------------------
// The happy password pair (basic.go:135-146 through the git chain)
// -----------------------------------------------------------------------------

describe("password Basic over git-HTTPS: the verified===null arm (basic.go:135-161)", () => {
  it("correct password clones a PRIVATE repo (owner identity → the synthetic all-scope → row owner grant)", async () => {
    const alice = await seedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "vault", isPrivate: true });

    const advert = await infoRefs("alice", "vault", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
    });
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("correct password opens the PUSH advert on the owner's own repo (write grant, basic.go:189-197's all-scope)", async () => {
    const alice = await seedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "pushable", isPrivate: true });

    const advert = await infoRefs("alice", "pushable", "git-receive-pack", {
      authorization: basicHeader("Alice", alice.password),
    });
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");
  });
});

// -----------------------------------------------------------------------------
// The wrong-password 401 — byte-exact against the pin's challenge site
// (githttp.go:146-159 + base.go:105-111: upstream answers the failed
// credential AT the anonymous challenge; http.Error appends the newline)
// -----------------------------------------------------------------------------

describe("the wrong-password 401 shape (githttp.go:146-159's !IsSigned arm)", () => {
  it("wrong password → the exact challenge bytes", async () => {
    const alice = await seedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "locked", isPrivate: true });

    const res = await infoRefs("alice", "locked", "git-upload-pack", {
      authorization: basicHeader("Alice", "wrong-password"),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("unknown user against an EXISTING repo → the same challenge (existence never disclosed; unknown REPO names 404 at the D1-miss passthrough, gate.test.ts)", async () => {
    const alice = await seedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "locked", isPrivate: true });

    const res = await infoRefs("alice", "locked", "git-upload-pack", {
      authorization: basicHeader("Ghost", "whatever"),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
  });

  it("WebAuthn-enrolled folds into the SAME challenge (identity never establishes — basic.go:155's message has no API envelope here)", async () => {
    const alice = await seedUserWithPassword("Alice");
    await seedWebAuthn(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "keyed", isPrivate: true });

    const res = await infoRefs("alice", "keyed", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
  });
});

// -----------------------------------------------------------------------------
// The repo-layer TOTP gate (githttp.go:160-172) and the anon-allowed-read
// exemption (the gate lives INSIDE !canAnonymousPull, githttp.go:132)
// -----------------------------------------------------------------------------

describe("the TOTP-enrollment 401 with the verbatim upstream message (githttp.go:172)", () => {
  it("PRIVATE repo read: absent OTP fails the password ARM → the generic challenge (the verbatim message needs a consumed OTP)", async () => {
    const alice = await seedUserWithPassword("Alice");
    await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "twofa", isPrivate: true });

    const res = await infoRefs("alice", "twofa", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
    });
    // totp-fail → identity never establishes → githttp.go:146-159's arm.
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
  });

  it("PRIVATE repo read: valid password + VALID OTP → the verbatim plain-text 401 — enrollment alone gates the repo layer (githttp.go:160-172 inside !canAnonymousPull)", async () => {
    const alice = await seedUserWithPassword("Alice");
    const { secret } = await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "twofaotp", isPrivate: true });

    const res = await infoRefs("alice", "twofaotp", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
      "x-gitea-otp": await totpCode(secret, Date.now() / 1000),
    });
    // Identity ESTABLISHED (Basic satisfied by the consumed OTP), but the
    // ctx.IsBasicAuth && !isToken && IsIndividual gate fires on enrollment
    // alone — upstream's TODO admits the body should be "invalid credentials".
    expect(res.status).toBe(401);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UPSTREAM_TOTP_PLAINTEXT);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    // Identity WAS established — the challenge header never rides this arm.
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("PRIVATE repo read: valid password + WRONG OTP → the password arm fails → the generic challenge instead", async () => {
    const alice = await seedUserWithPassword("Alice");
    await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "twofabad", isPrivate: true });

    const res = await infoRefs("alice", "twofabad", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
      "x-gitea-otp": "000000",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
  });

  it("WRITE is never exempt: TOTP-enrolled password-Basic push advert on a PUBLIC repo with a VALID OTP → the verbatim 401 (isPull=false ⇒ !canAnonymousPull)", async () => {
    const alice = await seedUserWithPassword("Alice");
    const { secret } = await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "twofapush", isPrivate: false });

    const res = await infoRefs("alice", "twofapush", "git-receive-pack", {
      authorization: basicHeader("Alice", alice.password),
      "x-gitea-otp": await totpCode(secret, Date.now() / 1000),
    });
    expect(res.status).toBe(401);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UPSTREAM_TOTP_PLAINTEXT);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// THE OTP LOCK LADDER over the git chain (c54ec52f0f's per-account
// failed-attempt limiter — twofactor.go:143-190 shared through
// basic.go:169-193's validateTOTP, the reserve-first D1 counter in
// auth/totp-attempts.ts): 5 wrong passcodes lock TOTP until 15 min after the
// LAST failure (renewed per failure), a success clears, the locked check
// precedes validation, an absent passcode never consumes.
//
// THE LOCK WIRE: upstream's TooManyAttempts ErrUserAuthMessage
// (basic.go:186) is an auth-method ERROR; Group.Verify returns the first
// error (group.go:78) and the web chain's handler answers
// `ctx.HTTPError(401, "Failed to authenticate user")` (web.go:160-163) —
// upstream's git wire folds the lock into the SAME error class as a wrong
// OTP, with no distinct body. The landed family renders every Basic miss as
// the Basic challenge (SPEC-0002's recorded shape, pinned above), so the
// lock rides the SAME challenge here: the behavioral lift is the consumed
// slot + the audit row (basic.go:182's RecordAs precedes the :186 branch,
// ORIGIN "ui" — the git mounts ride the web mid list's
// AuditOrigin(OriginUI), web.go:300/:1753, not the API chain's OriginAPI,
// api.go:971). The family-wide "Failed to authenticate user" error-body gap
// is recorded for the auth-chain owner (CENSUS note, not this arm's flip).
// -----------------------------------------------------------------------------

describe("the OTP lock ladder over the git chain (c54ec52f0f's limiter)", () => {
  const counterValue = async (): Promise<string | undefined> =>
    (await drizzle(env.DB).select({ settingValue: userSettingsKv.settingValue }).from(userSettingsKv).all())[0]
      ?.settingValue;

  it("5 wrong OTPs challenge each time; the 6th (locked) takes the SAME challenge — upstream folds the lock into the uniform auth-error class — and the audit rows ride every arm with origin ui", async () => {
    const alice = await seedUserWithPassword("Alice");
    await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "otpladder", isPrivate: true });
    // a per-test IP: the ladder's failed attempts share ONE limiter bucket
    // (threshold 20) — distinct keys keep the file's batteries independent.
    const headers = {
      authorization: basicHeader("Alice", alice.password),
      "x-gitea-otp": "000000",
      "cf-connecting-ip": "198.51.100.201",
    };

    for (let i = 0; i < 5; i++) {
      const res = await infoRefs("alice", "otpladder", "git-upload-pack", headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
    }
    expect((await counterValue())?.endsWith(":5")).toBe(true);

    const sixth = await infoRefs("alice", "otpladder", "git-upload-pack", headers);
    expect(sixth.status).toBe(401);
    expect(sixth.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await sixth.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
    // the locked arm consumed nothing (upstream's blocked branch has no Put)
    expect((await counterValue())?.endsWith(":5")).toBe(true);

    // the audit trail: 5 invalid arms + the locked arm, all
    // user:authentication:fail:twofactor at the WEB origin (the fixture's
    // repository:create row filtered out)
    await vi.waitFor(async () => {
      const rows = await drizzle(env.DB).select().from(auditEvents).all();
      const twofaRows = rows.filter((r) => r.action === "user:authentication:fail:twofactor");
      expect(twofaRows).toHaveLength(6);
      expect(new Set(rows.map((r) => r.action))).toEqual(new Set(["repository:create", "user:authentication:fail:twofactor"]));
      expect(twofaRows[5]).toMatchObject({ actorId: alice.id, origin: "ui", ipAddress: "198.51.100.201" });
    });
  });

  it("a CORRECT OTP stays refused while locked — the challenge (identity never establishes), never the verbatim enrollment plaintext", async () => {
    const alice = await seedUserWithPassword("Alice");
    const { secret } = await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "lockedok", isPrivate: true });
    const base = { authorization: basicHeader("Alice", alice.password), "cf-connecting-ip": "198.51.100.202" };

    for (let i = 0; i < 5; i++) {
      await infoRefs("alice", "lockedok", "git-upload-pack", { ...base, "x-gitea-otp": "000000" });
    }
    // UNLOCKED, a correct OTP on this private read establishes identity and
    // answers the verbatim plaintext WITHOUT the challenge header (the test
    // above) — LOCKED, identity never establishes and the generic challenge
    // answers instead: the lock changes the arm, not just the count.
    const locked = await infoRefs("alice", "lockedok", "git-upload-pack", {
      ...base,
      "x-gitea-otp": await totpCode(secret, Date.now() / 1000),
    });
    expect(locked.status).toBe(401);
    expect(locked.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await locked.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
  });

  it("every failure RENEWS the window (totpAttemptsTTL slides to the LAST failure — twofactor.go:56)", async () => {
    const alice = await seedUserWithPassword("Alice");
    await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "renew", isPrivate: true });
    const base = { authorization: basicHeader("Alice", alice.password), "cf-connecting-ip": "198.51.100.203" };

    await infoRefs("alice", "renew", "git-upload-pack", { ...base, "x-gitea-otp": "000000" });
    await infoRefs("alice", "renew", "git-upload-pack", { ...base, "x-gitea-otp": "000000" });

    // Backdate the counter near expiry (10 s left) with 4 slots spent: a
    // stale-window reset would restart at 1 and the ladder would never lock.
    const staleEpoch = Math.floor(Date.now() / 1000) - (15 * 60 - 10);
    await drizzle(env.DB).update(userSettingsKv).set({ settingValue: `${staleEpoch}:4` }).run();

    const third = await infoRefs("alice", "renew", "git-upload-pack", { ...base, "x-gitea-otp": "000000" });
    expect(third.status).toBe(401);
    expect(third.headers.get("www-authenticate")).toBe(CHALLENGE); // headroom 1 — the generic miss

    const renewed = (await counterValue()) ?? "";
    const [epochStr, countStr] = renewed.split(":");
    expect(countStr).toBe("5");
    expect(Number.parseInt(epochStr ?? "", 10)).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
  });

  it("a success CLEARS the counter (cache.Remove): 4 failures + a valid OTP on the anon-exempt public read → 200, then a full fresh ladder refits", async () => {
    const alice = await seedUserWithPassword("Alice");
    const { secret } = await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "clears", isPrivate: false });
    const base = { authorization: basicHeader("Alice", alice.password), "cf-connecting-ip": "198.51.100.204" };

    for (let i = 0; i < 4; i++) {
      const res = await infoRefs("alice", "clears", "git-upload-pack", { ...base, "x-gitea-otp": "000000" });
      expect(res.status).toBe(401);
    }
    const ok = await infoRefs("alice", "clears", "git-upload-pack", {
      ...base,
      "x-gitea-otp": await totpCode(secret, Date.now() / 1000),
    });
    expect(ok.status).toBe(200); // the exemption: a public read skips the enrollment gate
    expect(ok.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(await drizzle(env.DB).select().from(userSettingsKv).all()).toHaveLength(0);

    // a FULL fresh window: 5 wrong OTPs answer the generic miss each time (a
    // leftover count of 4 would have locked at the first) — the 6th finds
    // count 5 locked and consumes nothing
    for (let i = 0; i < 5; i++) {
      const res = await infoRefs("alice", "clears", "git-upload-pack", { ...base, "x-gitea-otp": "000000" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    }
    expect((await counterValue())?.endsWith(":5")).toBe(true);
    const sixth = await infoRefs("alice", "clears", "git-upload-pack", { ...base, "x-gitea-otp": "000000" });
    expect(sixth.status).toBe(401);
    expect((await counterValue())?.endsWith(":5")).toBe(true); // the locked arm extends nothing
  });
});

// -----------------------------------------------------------------------------
// The anon-allowed-read exemption × REQUIRE_SIGNIN_VIEW (githttp.go:132;
// the flag is census B-34/B-WAVE1 — api/config.ts requireSignInViewEnabled,
// apps/worker/wrangler.jsonc.example's strict-polarity var)
// -----------------------------------------------------------------------------

describe("the anon-allowed-read exemption under both flag postures (githttp.go:132)", () => {
  it("flag OFF: a public repo read is anonymously allowed, so the enrolled password-Basic clone WITH a valid OTP skips the repo gate — 200", async () => {
    expect(requireSignInViewEnabled(requireSignInViewEnv)).toBe(false);
    const alice = await seedUserWithPassword("Alice");
    const { secret } = await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "exempt", isPrivate: false });

    // The exemption's anonymous baseline: the same read works with NO
    // credentials at all (canAnonymousPull true ⇒ the whole branch skipped).
    const anon = await infoRefs("alice", "exempt", "git-upload-pack");
    expect(anon.status).toBe(200);
    expect(anon.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");

    // …and the enrolled doer WITH a consumed OTP rides the same open branch —
    // upstream never reaches its TOTP gate for a read anonymous callers make.
    const res = await infoRefs("alice", "exempt", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
      "x-gitea-otp": await totpCode(secret, Date.now() / 1000),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("flag OFF boundary: the exemption skips the REPO gate only, never the chain's OTP check — password without OTP on the same public repo → the challenge (basic.go:158-160 runs regardless)", async () => {
    expect(requireSignInViewEnabled(requireSignInViewEnv)).toBe(false);
    const alice = await seedUserWithPassword("Alice");
    await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "nototpfree", isPrivate: false });

    const res = await infoRefs("alice", "nototpfree", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
  });

  it("flag ON: canAnonymousPull dies (githttp.go:132) — the same exempt read (valid OTP) becomes the verbatim TOTP 401, and anonymous takes the challenge", async () => {
    requireSignInViewEnv.REQUIRE_SIGNIN_VIEW = "true";
    expect(requireSignInViewEnabled(requireSignInViewEnv)).toBe(true);
    const alice = await seedUserWithPassword("Alice");
    const { secret } = await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "flagged", isPrivate: false });

    // Row 6: the flag kills EVERY anonymous read — even this public repo's.
    const anon = await infoRefs("alice", "flagged", "git-upload-pack");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(CHALLENGE);

    // …and the enrolled doer's password-Basic read now runs the gate: the
    // verbatim message (upstream pins the flag's refusal posture with its
    // own anonymous-unit-read test, git_smart_http_test.go:186-188).
    const res = await infoRefs("alice", "flagged", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
      "x-gitea-otp": await totpCode(secret, Date.now() / 1000),
    });
    expect(res.status).toBe(401);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UPSTREAM_TOTP_PLAINTEXT);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("flag ON does NOT touch non-2FA password clones: the signed-in ladder rides unchanged (config.ts:40)", async () => {
    requireSignInViewEnv.REQUIRE_SIGNIN_VIEW = "true";
    const alice = await seedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "signedclone", isPrivate: false });

    const res = await infoRefs("alice", "signedclone", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });
});

// -----------------------------------------------------------------------------
// THE FLAGGED-DOER GATE (SPEC-0002 §6.3.1's census B-82 residue): the smart-
// HTTP family mounts INSIDE webRoutes under optSignInFromAnyOrigin (web.go:
// 1782; LFS :1778), whose NeedChangePassword branch (web.go:197-206) answers
// a flagged doer BEFORE httpBase's ladder — the git UA takes the 401 locale
// string ("Update your password", http.Error's wire), a non-git UA the 303,
// never the pack. Identity must ESTABLISH first (both carriers — the
// password arm's row and the token carrier), so a failed credential still
// takes the generic challenge below.
// -----------------------------------------------------------------------------

describe("the flagged-doer must-change gate (optSignInFromAnyOrigin over the git mounts, web.go:197-206/:1782)", () => {
  async function seedFlaggedUserWithPassword(username: string): Promise<{ id: number; password: string }> {
    const user = await seedUserWithPassword(username);
    await drizzle(env.DB).update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id));
    return user;
  }

  it("a flagged doer's password-Basic clone → the 401 locale string, verbatim wire (web.go:199-201) — never the advert", async () => {
    const alice = await seedFlaggedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "gated", isPrivate: true });

    const res = await infoRefs("alice", "gated", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
      "user-agent": "git/2.45.0",
    });
    expect(res.status).toBe(401);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("Update your password\n");
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Identity ESTABLISHED (the flagged row authenticated) — the Basic
    // challenge header never rides this arm (upstream's HTTPError is a bare
    // http.Error).
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("the gate precedes the repo ladder: a flagged TOTP-enrolled doer WITH a valid OTP answers the must-change 401, not the TOTP plaintext (middleware-before-handler, web.go:197 vs githttp.go:160-172)", async () => {
    const alice = await seedFlaggedUserWithPassword("Alice");
    const { secret } = await seedTotp(alice.id);
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "gatedtotp", isPrivate: true });

    const res = await infoRefs("alice", "gatedtotp", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
      "x-gitea-otp": await totpCode(secret, Date.now() / 1000),
      "user-agent": "git/2.45.0",
    });
    expect(res.status).toBe(401);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("Update your password\n");
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("the token carrier is gated too (upstream's OAuth2 method resolves the same doer): a flagged holder's PAT → the 401 locale string", async () => {
    const alice = await seedFlaggedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "gatedpat", isPrivate: true });
    const pat = await mintFor(alice.id, "pat", "all");

    const res = await infoRefs("alice", "gatedpat", "git-upload-pack", {
      authorization: `Bearer ${pat.plaintext}`,
      "user-agent": "git/2.45.0",
    });
    expect(res.status).toBe(401);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("Update your password\n");
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("a NON-git UA takes the 303 redirect arm instead (web.go:202-204) — the arm's UA branch, not a git-only shape", async () => {
    const alice = await seedFlaggedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "gatedcurl", isPrivate: true });

    // redirect:"manual" — the default follow would chase the 303 onto the
    // change-password page (which renders the sign-in round-trip for this
    // Basic-only, sessionless request) and the pin would assert the wrong
    // surface entirely.
    const res = await SELF.fetch(`https://example.com/alice/gatedcurl.git/info/refs?service=git-upload-pack`, {
      redirect: "manual",
      headers: {
        authorization: basicHeader("Alice", alice.password),
        "user-agent": "curl/8.5.0",
      },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/change_password");
  });

  it("a FAILED credential still takes the generic challenge (identity never establishes — the gate needs a doer)", async () => {
    const alice = await seedFlaggedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "gatedwrong", isPrivate: true });

    const res = await infoRefs("alice", "gatedwrong", "git-upload-pack", {
      authorization: basicHeader("Alice", "wrong-password"),
      "user-agent": "git/2.45.0",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
  });
});

// -----------------------------------------------------------------------------
// THE SHARED KNOB over the git chain (basic.go:139-141 — census B-87's
// route-glue half, the GLUE unit e4212fe): with EnableBasicAuth OFF the Basic
// PASSWORD method is NOT APPLICABLE — `return nil, nil` — the chain ends
// UNSIGNED and the request proceeds ANONYMOUS (the matrix's row-1 decide: a
// public read serves, a protected route answers its OWN challenge). NEVER the
// failed-credential arm: upstream never tests the pair, so the failure limiter
// records nothing either (the discriminator — a credential-failure challenge
// rides limiterRecordFailureFailOpen, acl.ts's generic-miss arm). Basic-carried
// TOKENS verify BEFORE the gate (basic.go:134-137's VerifyAuthToken arm — the
// gate sits after the access-token arm, mirroring the API chain's ordering,
// middleware-wire.test.ts's knob battery) and stay unaffected. The knob-ON
// posture is every describe above (the default var is "true" — the generated
// Env literal).
// -----------------------------------------------------------------------------

describe("ENABLE_BASIC_AUTHENTICATION=off — the git chain's anonymous proceed (basic.go:139-141)", () => {
  // The knob slice rides the test env (the REQUIRE_SIGNIN_VIEW pattern — the
  // vitest plugin injects wrangler VARS and SELF.fetch shares this object).
  const basicAuthEnv = env as Omit<Env, "ENABLE_BASIC_AUTHENTICATION"> & {
    ENABLE_BASIC_AUTHENTICATION?: string;
  };
  afterEach(() => {
    basicAuthEnv.ENABLE_BASIC_AUTHENTICATION = "true";
  });

  const failureRows = async (): Promise<number> => (await drizzle(env.DB).select().from(authFailures).all()).length;

  it("knob OFF + a VALID Basic PASSWORD pair on a PUBLIC repo read → anonymous SERVE (the 200 advert), never the challenge, no failure-limiter row", async () => {
    basicAuthEnv.ENABLE_BASIC_AUTHENTICATION = "false";
    const alice = await seedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "openpull", isPrivate: false });

    const res = await infoRefs("alice", "openpull", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    // The identity never establishes (the arm never ran — a VALID pair, yet
    // the request was served anonymous) and no credential test happened, so
    // the limiter stays empty.
    expect(await failureRows()).toBe(0);
  });

  it("knob OFF + a VALID Basic PASSWORD pair on a PRIVATE repo read → the matrix's OWN anonymous challenge 401 — never the failed-credential arm (no limiter row for a pair that would have authenticated)", async () => {
    basicAuthEnv.ENABLE_BASIC_AUTHENTICATION = "false";
    const alice = await seedUserWithPassword("Alice");
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "locked", isPrivate: true });

    const res = await infoRefs("alice", "locked", "git-upload-pack", {
      authorization: basicHeader("Alice", alice.password),
    });
    // The anonymous decide's challenge — the exact bytes the row-1 anonymous
    // arm answers (githttp.go:146-159's !IsSigned site), NOT a credential
    // verdict: the VALID pair proves the ladder never ran, and the empty
    // limiter proves the generic-miss record never fired either.
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(UNAUTHORIZED_BODY);
    expect(await failureRows()).toBe(0);
  });

  it("knob OFF + a Basic-carried TOKEN still authenticates (the token arm precedes the gate, basic.go:134-137) — the PRIVATE read serves", async () => {
    basicAuthEnv.ENABLE_BASIC_AUTHENTICATION = "false";
    const alice = await seedVerifiedUser({ username: "Alice" });
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "tokenpull", isPrivate: true });
    const pat = await mintFor(alice.id, "pat", "all");

    const res = await infoRefs("alice", "tokenpull", "git-upload-pack", {
      authorization: basicHeader("Alice", pat.plaintext),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });
});
