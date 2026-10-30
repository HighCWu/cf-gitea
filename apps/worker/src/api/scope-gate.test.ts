/**
 * Tree-wide token-scope gate pins (auth-parity H1 — docs/usability/
 * parity-review-auth.md §4 drift 1): the mounted-chain assertions for the
 * group table src/api/scope-gate.ts implements. The suite drives the REAL
 * worker through SELF (resolveAuth → sudo → the api router with the gate
 * mounted ahead of every family) with D1-minted tokens, pinning upstream's
 * group semantics at the pin (routers/api/v1/api.go:1009-1872):
 *
 *   - a read:repository token GETs its repo but 403s a repo EDIT (the
 *     method-derived write level, api.go:285-289 + 1554);
 *   - a scopeless token (no-token-scope) 403s gated reads AND writes —
 *     upstream's gate applies whenever a token is the doer, even one whose
 *     scope holds no permission (api.go:281-300: GetDoerTokenScope's ok
 *     branch covers the empty bitmap) — while ungated misc reads (/version)
 *     still answer;
 *   - ANONYMOUS callers pass the gate (upstream returns early when no token
 *     scope exists) and the public repo read stays anonymous-visible; the
 *     write arm answers reqToken's 401, not the gate's 403;
 *   - the issue family is a SIBLING chi group (api.go:1692-1714): a
 *     read:issue token reads issues but cannot read repo metadata — the
 *     repo-scope gate of the main /repos group does not apply there;
 *   - token CRUD keeps its user-category arm (auth/router.ts's own
 *     requireScope("user"), api.go:1060-1071): read:user passes, a
 *     repository-scoped token 403s with required=[read:user].
 */

import { SELF, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { TokenService } from "../auth/token-service";

const ORIGIN = "https://example.com";
const SWAGGER_URL = `${ORIGIN}/api/swagger`;

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  // Tokens only: repos/users accumulate (their dependents make a full wipe
  // an FK dance) and every test seeds its OWN user, so names never collide.
  await env.DB.prepare("DELETE FROM personal_access_tokens").run();
});

interface Seeded {
  id: number;
  username: string;
  /** bootstrap-shaped all-scope credential (scripts/bootstrap-admin.mjs's posture). */
  admin: string;
}

async function seedOwnerWithRepo(slug: string): Promise<Seeded> {
  // Per-test username: rows accumulate across the file (see beforeEach), so
  // the unique username_lower key needs a unique seed per test.
  const owner = await seedVerifiedUser({ username: `gate-owner-${slug}` });
  const admin = (await mintFor(owner.id, "bootstrap", "all")).plaintext;
  const created = await SELF.fetch(`${ORIGIN}/api/v1/user/repos`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(admin), "content-type": "application/json" },
    body: JSON.stringify({ name: slug, private: false }),
  });
  expect(created.status).toBe(201);
  return { id: owner.id, username: owner.username, admin };
}

/** Upstream api.go:300's exact 403 body (Go %v slice rendering). */
const scopeForbidden = (required: string, tokenScope: string): Record<string, string> => ({
  message: `token does not have at least one of required scope(s), required=[${required}], token scope=${tokenScope}`,
  url: SWAGGER_URL,
});

describe("tree-wide token-scope gates (auth-parity H1)", () => {
  it("a read:repository token GETs its repo but 403s a repo EDIT with the upstream message", async () => {
    const seeded = await seedOwnerWithRepo("readpin");
    const readToken = (await mintFor(seeded.id, "ro", "read:repository")).plaintext;

    const got = await SELF.fetch(`${ORIGIN}/api/v1/repos/${seeded.username.toLowerCase()}/readpin`, {
      headers: { authorization: basicTokenHeader(readToken) },
    });
    expect(got.status).toBe(200);

    const patched = await SELF.fetch(`${ORIGIN}/api/v1/repos/${seeded.username.toLowerCase()}/readpin`, {
      method: "PATCH",
      headers: { authorization: basicTokenHeader(readToken), "content-type": "application/json" },
      body: JSON.stringify({ description: "scope escalation attempt" }),
    });
    expect(patched.status).toBe(403);
    expect(await patched.json()).toEqual(scopeForbidden("write:repository", "read:repository"));
  });

  it("a no-token-scope token 403s gated reads and writes while ungated misc still answers", async () => {
    const seeded = await seedOwnerWithRepo("scopeless");
    // Mintable: normalizeScope's no-token-scope special case survives mint's
    // empty-string rejection (scopes.ts:219-221) — an upstream-mintable
    // degenerate credential whose bitmap holds no permission.
    const scopeless = (await new TokenService(env.DB).mint({ userId: seeded.id, name: "none", scopes: "no-token-scope" }))
      .plaintext;

    const repo = `${ORIGIN}/api/v1/repos/${seeded.username.toLowerCase()}/scopeless`;
    const got = await SELF.fetch(repo, { headers: { authorization: basicTokenHeader(scopeless) } });
    expect(got.status).toBe(403);
    expect(await got.json()).toEqual(scopeForbidden("read:repository", "no-token-scope"));

    const posted = await SELF.fetch(repo, {
      method: "PATCH",
      headers: { authorization: basicTokenHeader(scopeless), "content-type": "application/json" },
      body: JSON.stringify({ description: "nope" }),
    });
    expect(posted.status).toBe(403);
    expect(await posted.json()).toEqual(scopeForbidden("write:repository", "no-token-scope"));

    // Outside every tokenRequiresScopes group (api.go:1002-1027): the misc
    // family keeps answering — the gate is per-group, never blanket.
    const version = await SELF.fetch(`${ORIGIN}/api/v1/version`, {
      headers: { authorization: basicTokenHeader(scopeless) },
    });
    expect(version.status).toBe(200);
  });

  it("anonymous passes the public reads and answers reqToken's 401 on writes — never the gate's 403", async () => {
    const seeded = await seedOwnerWithRepo("anonpin");
    const repo = `${ORIGIN}/api/v1/repos/${seeded.username.toLowerCase()}/anonpin`;

    const got = await SELF.fetch(repo);
    expect(got.status).toBe(200);

    const patched = await SELF.fetch(repo, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "anon" }),
    });
    expect(patched.status).toBe(401);
    expect(await patched.json()).toEqual({ message: "token is required", url: SWAGGER_URL });
  });

  it("the issue family is a sibling group: read:issue reads issues but not repo metadata", async () => {
    const seeded = await seedOwnerWithRepo("issuepin");
    const issueToken = (await mintFor(seeded.id, "issues", "read:issue")).plaintext;
    const base = `${ORIGIN}/api/v1/repos/${seeded.username.toLowerCase()}/issuepin`;

    const issues = await SELF.fetch(`${base}/issues`, { headers: { authorization: basicTokenHeader(issueToken) } });
    expect(issues.status).toBe(200);

    // /repos/{o}/{r} itself sits in the REPO-scope group (api.go:1554) — the
    // sibling gate the issue group never carries.
    const repo = await SELF.fetch(base, { headers: { authorization: basicTokenHeader(issueToken) } });
    expect(repo.status).toBe(403);
    expect(await repo.json()).toEqual(scopeForbidden("read:repository", "read:issue"));
  });

  it("token CRUD keeps its user-category arm: read:user passes, read:repository 403s with required=[read:user]", async () => {
    const seeded = await seedOwnerWithRepo("crudpin");
    const userToken = (await mintFor(seeded.id, "user-ro", "read:user")).plaintext;
    const repoToken = (await mintFor(seeded.id, "repo-ro", "read:repository")).plaintext;
    const list = `${ORIGIN}/api/v1/users/${seeded.username}/tokens`;

    // read:user still lists over the Basic token form (upstream's CRUD gate
    // reqBasicOrRevProxyAuth — the `token`-header form of the SAME credential
    // is refused there)…
    const listed = await SELF.fetch(list, { headers: { authorization: `token ${userToken}` } });
    expect(listed.status).toBe(401); // reqBasicOrRevProxyAuth: token-header form is refused
    const listedBasic = await SELF.fetch(list, {
      headers: { authorization: `Basic ${btoa(`${seeded.username}:${userToken}`)}` },
    });
    expect(listedBasic.status).toBe(200);

    // …while a repository-scoped credential fails the USER category exactly
    // like the token-CRUD router's own mount (auth/router.ts:83) — the
    // tree-wide gate adds the same requirement, never a weaker one.
    const forbidden = await SELF.fetch(list, {
      headers: { authorization: `Basic ${btoa(`${seeded.username}:${repoToken}`)}` },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual(scopeForbidden("read:user", "read:repository"));
  });
});
