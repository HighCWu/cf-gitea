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
import { beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, seedVerifiedUser } from "../auth/testing/seeds";
import { totpCode } from "../auth/totp";
import { applyTwofaEnrollment, generateTotpSecret, mintPendingTicket } from "../auth/two-factor";
import { newPasswordRecord } from "../auth/password";
import { createCredential } from "../web/webauthn-store";
import { encodeCoseKey } from "../web/webauthn-ceremony";
import { RepoService } from "../repos/service";
import { users } from "../db/schema";
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
