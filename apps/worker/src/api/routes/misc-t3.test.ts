/**
 * The user-account key/email family on real D1 (routes/misc-t3.ts over the
 * migration-0016 tables email_addresses / public_keys / gpg_keys): the
 * signing-key pair, the user emails CRUD, the SSH/GPG key CRUD (user +
 * admin arms), the GPG verification token, and the admin email listings.
 *
 * Standalone mount per the tier-2 convention (the routes ARE registered in
 * router.ts); each test token resolves to a seeded D1 user row via the
 * user-read-t2.test.ts resolver pattern, so the storage-backed handlers hit
 * real tables.
 *
 * Key fixtures are REAL keys (generated with ssh-keygen / gpg --batch at
 * authoring time and embedded): the SSH fingerprints and GPG key ids below
 * are the tools' own outputs, so the parsers' outputs assert against
 * independent ground truth.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { users } from "../../db/schema";
import { createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerMiscT3Routes } from "./misc-t3";

const NOW = new Date("2026-02-03T04:05:06Z");

const TOKEN = "stub-token"; // seed user id 1 (cf-gitea-stub)
const TOKEN_NEIGHBOR = "neighbor-token";
const TOKEN_ADMIN = "admin-token";

let neighborId = 0;

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return Promise.resolve(STUB_USER);
      if (token === TOKEN_NEIGHBOR) {
        return Promise.resolve({ ...STUB_USER, id: neighborId, login: "neighbor", email: "" });
      }
      if (token === TOKEN_ADMIN) {
        return Promise.resolve({ ...STUB_USER, id: neighborId + 1, login: "root", is_admin: true });
      }
      return Promise.resolve(null);
    },
  };
}

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const authed = (init?: RequestInit, token = TOKEN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const json = (body: unknown, init?: RequestInit): RequestInit => ({
  ...init,
  headers: new Headers({ ...init?.headers, "Content-Type": "application/json" }),
  body: JSON.stringify(body),
});

const miscSend = familyApp((app) => registerMiscT3Routes(app, createTokenAuthMiddleware(resolver())));

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  const { applyRepoExtrasDdl } = await import("../testing/repo-ddl");
  await applyRepoExtrasDdl();
});

beforeEach(async () => {
  for (const table of ["email_addresses", "public_keys", "gpg_keys", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  neighborId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
  await drizzle(env.DB)
    .insert(users)
    .values({ username: "root", usernameLower: "root", isAdmin: true, status: "active", createdAt: NOW });
});

// ---------------------------------------------------------------------------
// Fixtures (generated at authoring time; fingerprints/key ids are the tools')
// ---------------------------------------------------------------------------

const ED25519_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICQgLhusngED6SvOcMDWHg9wVjgOJ4QTN77gPol4OtTU ed25519-comment user@host";
const ED25519_FINGERPRINT = "SHA256:nBIbxZfae58Hod5zlVgetQGtfn2OhEymkNryw9sEXR8";
const RSA_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC3sBogtkFTvHdp6XkAThDF9Xqbfri5C/mGWrH4vnwBhnWFULjS5Kcu9Sk1Rz0FsCvnsEG9Fnbkaq9g28Wv7QZZsWmkC+UfvSoMVIt3koKLYwweRv3do/TzL/2KT5BBGTSCUGeotpkP8znF3fK6xi7A7zf9cBzfL8P2tNnLR+XqgGfVuRFjVXd2wjjtpEhOHLK4BIncKpoI6TgIHwFayxH+DrNQDTjpCw7NWef5jsstb0ICBRQti5QNc+uYm1qQPDTsZ8ZlljnOxy/4Au6aPXpq2jUHQWfBFy+IrVeVEoGIacrBMK5aAjS/aHDIKDVql0km8r8BMFlfNDD/Lff5v59f";
const RSA_FINGERPRINT = "SHA256:I5plbz5CJDzZiBSGXjZBVDpAS8c0FI3jzxrjbQSfaaU";

/** gpg --batch RSA key, identity <gpg-match@example.com>. */
const GPG_MATCH = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQENBGrdiKUBCADLIFk7mpME1/TzoMJho/1vIwCBFBn/XCLcrOdO3VbTsfJN9hNn
jTgBmCGckgAbEQCPyyIkic8mKyXnKrEgaCW+Arj4S6Pn/Z1OyxQUDK4Uu1IgIfWZ
irt335mVG9DMg7Jng6OLcjjvWZ+Ae/E/96km405Nrkl8f7Q96+boYtTExTR2Ud7E
3ZtUvQKlWqFBGkDYUNJwS7UbRiKeT3tCo6IubHkfLynaQdVlZtWOScqHAq4Zl9nK
PVFCiiZ4ap75z8bvU56XBSTYO+H92ypK2rI3T5SqI1gPBLssZNaMIPpey4YJVCRn
z6ZHZ9P/+WEzEmUmCRnOcRBaWSHbY7/9Yoh3ABEBAAG0JkdQRyBNYXRjaCBVc2Vy
IDxncGctbWF0Y2hAZXhhbXBsZS5jb20+iQFSBBMBCgA8FiEEDYeaF/v9XPgrsrIQ
TsrixgWc7IwFAmrdiKUDGy8EBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJ
EE7K4sYFnOyM/igH+QEqC+IqN4ERmDLCkSZDfTOroUvo3eaqfjigYLhqsb4c47/F
2GSO1oFogsQDOeSvfOflma96w3GSNHcfeuooUOke7BZ5HJhjTHq2HnIsdJu4W1Id
dQYNMKhvM5xVAmCEGOVPWxKqZ23ssMOw0S65L3DFZYj8CO7Et5nTxv1oWhWneyds
pSDFaM0olTwJw65S/zWOVWSZjO0RPeVadIEKbHVzcpd0RzMZRWmAF+RCQjjLsplC
n5kNajOhI7uO6SoGaA0FFKUP6Q8VyQbxL/cnZj8fIfx1deIUc/z1cp7axbIP0nOu
PbA9TA0CiE5CFqgwsHsSGUROJgHbOpr+V472h0I=
=OqCl
-----END PGP PUBLIC KEY BLOCK-----`;
const GPG_MATCH_KEY_ID = "4ECAE2C6059CEC8C";
const GPG_MATCH_CREATED = new Date(1792903333 * 1000).toISOString();

/** gpg --batch RSA primary + subkey, identity <gpg-sub@example.com>. */
const GPG_SUBKEYED = `-----BEGIN PGP PUBLIC KEY BLOCK-----

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
x9Cc2hS77zt37F0=
=lpMM
-----END PGP PUBLIC KEY BLOCK-----`;
const GPG_SUBKEYED_PRIMARY_KEY_ID = "4E2EE4068358A108";
const GPG_SUBKEYED_SUBKEY_KEY_ID = "5C0FA0727EDC50F6";

const GO_ZERO = "0001-01-01T00:00:00Z";

/** Add the given address to the doer through the API (activates it). */
async function addEmail(email: string): Promise<void> {
  const response = await miscSend("/user/emails", authed(json({ emails: [email] }, { method: "POST" })));
  expect(response.status).toBe(201);
}

// ---------------------------------------------------------------------------
// Declared response codes ⊆ vendored contract (SPEC-0004 §5.2 subset rule,
// asserted on the standalone mount — these ops reach the shared checker only
// after the orchestrator registers the family in router.ts, already done for
// the six upgraded ops)
// ---------------------------------------------------------------------------

describe("misc-t3 declared operations (misc-t3)", () => {
  it("declares exactly the contract codes, plus the granted signing-key 404 exceptions", () => {
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    registerMiscT3Routes(app, createTokenAuthMiddleware(resolver()));
    const doc = app.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "misc-t3", version: "0" },
    });

    /** Declared → contract-allowed (the /signing-key 404s are the
     *  RUNTIME_ONLY_RESPONSES grants; every other code is contract-declared
     *  verbatim — the /admin/users/{username}/keys miss-404 is emitted at
     *  runtime only and deliberately NOT declared, see the module header). */
    const expected: Record<string, Record<string, string[]>> = {
      "/signing-key.gpg": { get: ["200", "404"] },
      "/signing-key.pub": { get: ["200", "404"] },
      "/user/emails": {
        get: ["200"],
        post: ["201", "400", "409", "422"],
        delete: ["204", "404"],
      },
      "/user/keys": {
        get: ["200", "401", "403"],
        post: ["201", "401", "403", "422"],
      },
      "/user/keys/{id}": {
        get: ["200", "401", "403", "404"],
        delete: ["204", "401", "403", "404"],
      },
      "/user/gpg_keys": {
        get: ["200", "401", "403"],
        post: ["201", "401", "403", "404", "422"],
      },
      "/user/gpg_keys/{id}": {
        get: ["200", "401", "403", "404"],
        delete: ["204", "401", "403", "404"],
      },
      "/user/gpg_key_token": { get: ["200", "401", "403", "404"] },
      "/admin/emails": { get: ["200", "403"] },
      "/admin/emails/search": { get: ["200", "403"] },
      "/admin/users/{username}/keys": {
        post: ["201", "403", "422"],
      },
      "/admin/users/{username}/keys/{id}": {
        delete: ["204", "403", "404"],
      },
    };

    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(Object.keys(expected).sort());
    for (const [path, methods] of Object.entries(expected)) {
      for (const [method, codes] of Object.entries(methods)) {
        const operation = (doc.paths?.[path] as Record<string, never> | undefined)?.[method] as
          | { responses: Record<string, unknown>; operationId: string }
          | undefined;
        expect(operation, `${method} ${path}`).toBeDefined();
        expect(Object.keys(operation!.responses).sort()).toEqual([...codes].sort());
      }
    }
  });
});

// ---------------------------------------------------------------------------
// GET /signing-key.gpg + /signing-key.pub (the misc/signing.go no-key arm)
// ---------------------------------------------------------------------------

describe("GET /signing-key.gpg|pub (misc-t3)", () => {
  for (const path of ["/signing-key.gpg", "/signing-key.pub"]) {
    it(`${path} answers the honest no-signing-key 404, anonymously`, async () => {
      const response = await miscSend(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        message: "no signing key",
        url: "https://example.com/api/swagger",
      });
      expect((await miscSend(path, authed())).status).toBe(404);
    });
  }
});

// ---------------------------------------------------------------------------
// User emails (user/email.go over email_addresses + the synthesized primary)
// ---------------------------------------------------------------------------

describe("GET /user/emails (misc-t3)", () => {
  it("anonymous callers get the requireAuth 401 (the runtime-only class)", async () => {
    const response = await miscSend("/user/emails");
    expect(response.status).toBe(401);
    const body: Record<string, unknown> = await response.json();
    expect(body.message).toBe("token is required");
  });

  it("renders [] with no addresses and no users.email", async () => {
    const response = await miscSend("/user/emails", authed());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("unions the synthesized primary from users.email first, upstream ToEmail shape", async () => {
    await env.DB.prepare("UPDATE users SET email = 'Primary@Example.com' WHERE id = 1").run();
    const response = await miscSend("/user/emails", authed());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { email: "Primary@Example.com", verified: true, primary: true, user_id: 0, username: "" },
    ]);
  });
});

describe("POST /user/emails (misc-t3)", () => {
  it("adds activated non-primary addresses and re-lists everything with 201", async () => {
    await env.DB.prepare("UPDATE users SET email = 'primary@example.com' WHERE id = 1").run();
    const response = await miscSend(
      "/user/emails",
      authed(json({ emails: ["Alt@Example.com"] }, { method: "POST" })),
    );
    expect(response.status).toBe(201);
    const createdList = await response.json();
    expect(createdList).toEqual([
      { email: "primary@example.com", verified: true, primary: true, user_id: 0, username: "" },
      { email: "Alt@Example.com", verified: true, primary: false, user_id: 0, username: "" },
    ]);

    const listed = await miscSend("/user/emails", authed());
    expect(await listed.json()).toEqual(createdList);
  });

  it("409s a duplicate row, a batch-internal duplicate, and any user's primary", async () => {
    await addEmail("taken@example.com");
    for (const payload of [
      { emails: ["taken@example.com"] }, // own row
      { emails: ["fresh@example.com", "fresh@example.com"] }, // within the batch
      { emails: ["primary@example.com"] }, // neighbor's users.email (seeded below)
    ]) {
      if (payload.emails[0] === "primary@example.com") {
        await drizzle(env.DB).update(users).set({ email: "primary@example.com" }).where(eq(users.id, neighborId));
      }
      const response = await miscSend("/user/emails", authed(json(payload, { method: "POST" })));
      expect(response.status).toBe(409);
      const body: Record<string, unknown> = await response.json();
      expect(body.message).toBe(`e-mail already in use [email: ${payload.emails[0]}]`);
    }
    // Nothing partial landed from the failing batch.
    const listed = await miscSend("/user/emails", authed());
    expect(await listed.json()).toEqual([{ email: "taken@example.com", verified: true, primary: false, user_id: 0, username: "" }]);
  });

  it("400s an invalid address with the upstream message, 422s an empty list", async () => {
    const invalid = await miscSend("/user/emails", authed(json({ emails: ["not-an-email"] }, { method: "POST" })));
    expect(invalid.status).toBe(400);
    const invalidBody: Record<string, unknown> = await invalid.json();
    expect(invalidBody.message).toBe("email address is invalid: not-an-email");

    for (const payload of [{ emails: [] }, {}]) {
      const empty = await miscSend("/user/emails", authed(json(payload, { method: "POST" })));
      expect(empty.status).toBe(422);
      const emptyBody: Record<string, unknown> = await empty.json();
      expect(emptyBody.message).toBe("Email list empty");
    }
  });
});

describe("DELETE /user/emails (misc-t3)", () => {
  it("deletes listed rows with 204, then 404s the second attempt (upstream message)", async () => {
    await addEmail("gone@example.com");
    const first = await miscSend(
      "/user/emails",
      authed(json({ emails: ["GONE@example.com", "missing@example.com"] }, { method: "DELETE" })),
    );
    // All-or-nothing: the missing second address rolls the batch back to the
    // upstream not-exist 404 with the offending address named.
    expect(first.status).toBe(404);
    const body: Record<string, unknown> = await first.json();
    expect(body.message).toBe("Email address does not exist [email: missing@example.com]");

    const second = await miscSend("/user/emails", authed(json({ emails: ["gone@example.com"] }, { method: "DELETE" })));
    expect(second.status).toBe(204);
    const listed = await miscSend("/user/emails", authed());
    expect(await listed.json()).toEqual([]);

    const again = await miscSend("/user/emails", authed(json({ emails: ["gone@example.com"] }, { method: "DELETE" })));
    expect(again.status).toBe(404);
  });

  it("empty list is the upstream no-op 204; the synthesized primary 404s (documented corner)", async () => {
    expect((await miscSend("/user/emails", authed(json({ emails: [] }, { method: "DELETE" })))).status).toBe(204);
    expect((await miscSend("/user/emails", authed({ method: "DELETE" }))).status).toBe(204);

    await env.DB.prepare("UPDATE users SET email = 'primary@example.com' WHERE id = 1").run();
    // Upstream finds its materialized primary row and its delete path
    // answers an OUT-OF-CONTRACT 500 (user/email.go:122-128); cf-gitea's
    // primary is not a row, so the in-contract not-exist 404 answers.
    const primary = await miscSend(
      "/user/emails",
      authed(json({ emails: ["primary@example.com"] }, { method: "DELETE" })),
    );
    expect(primary.status).toBe(404);
    const body: Record<string, unknown> = await primary.json();
    expect(body.message).toBe("Email address does not exist [email: primary@example.com]");
  });
});

// ---------------------------------------------------------------------------
// SSH public keys (user/key.go + admin arms over public_keys)
// ---------------------------------------------------------------------------

describe("POST /user/keys (misc-t3)", () => {
  it("creates a key with the upstream render: SHA256 fingerprint, url, private info", async () => {
    const response = await miscSend(
      "/user/keys",
      authed(json({ title: "laptop", key: ED25519_KEY, read_only: true }, { method: "POST" })),
    );
    expect(response.status).toBe(201);
    const body = await response.json<Record<string, unknown>>();
    const keyId = body.id as number;
    expect(Number.isFinite(keyId)).toBe(true);
    expect(body.title).toBe("laptop");
    // read_only is accepted-and-ignored on the user-key path (upstream
    // AddPublicKey always writes AccessModeWrite).
    expect(body.read_only).toBe(false);
    expect(body.key).toBe(ED25519_KEY);
    expect(body.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(body.url).toBe(`https://example.com/api/v1/user/keys/${keyId}`);
    expect(body.key_type).toBe("user");
    expect((body.user as Record<string, unknown>).login).toBe("cf-gitea-stub");
    expect(typeof body.created_at).toBe("string");
    expect(body.last_used_at).toBe(body.created_at);
  });

  it("422s fingerprint reuse across owners and title reuse per owner", async () => {
    const first = await miscSend("/user/keys", authed(json({ title: "laptop", key: ED25519_KEY }, { method: "POST" })));
    expect(first.status).toBe(201);

    const sameTitle = await miscSend(
      "/user/keys",
      authed(json({ title: "laptop", key: RSA_KEY }, { method: "POST" })),
    );
    expect(sameTitle.status).toBe(422);
    expect((await sameTitle.json<Record<string, unknown>>()).message).toBe("Key title has been used");

    const neighborSameKey = await miscSend(
      "/user/keys",
      authed(json({ title: "laptop", key: ED25519_KEY }, { method: "POST" }), TOKEN_NEIGHBOR),
    );
    expect(neighborSameKey.status).toBe(422);
    expect((await neighborSameKey.json<Record<string, unknown>>()).message).toBe(
      "Key content has been used as non-deploy key",
    );
  });

  it("422s invalid content with the upstream prefix and missing required fields", async () => {
    for (const key of ["totally not a key", "-----BEGIN PUBLIC KEY-----", "ssh-ed25519 !!!!"] as const) {
      const response = await miscSend("/user/keys", authed(json({ title: "k", key }, { method: "POST" })));
      expect(response.status).toBe(422);
      expect((await response.json<Record<string, unknown>>()).message).toContain("Invalid key content:");
    }
    const wrongType = await miscSend(
      "/user/keys",
      authed(json({ title: "k", key: `ssh-rsa ${ED25519_KEY.split(" ")[1]}` }, { method: "POST" })),
    );
    expect(wrongType.status).toBe(422);
    expect((await wrongType.json<Record<string, unknown>>()).message).toContain(
      "key type and content does not match: ssh-rsa - ssh-ed25519",
    );

    for (const payload of [{ key: ED25519_KEY }, { title: "k" }, {}]) {
      const missing = await miscSend("/user/keys", authed(json(payload, { method: "POST" })));
      expect(missing.status).toBe(422);
    }
    expect((await miscSend("/user/keys", authed({ method: "POST" }))).status).toBe(422);
  });
});

describe("GET /user/keys[/{id}] (misc-t3)", () => {
  it("anonymous callers get the requireAuth 401", async () => {
    expect((await miscSend("/user/keys")).status).toBe(401);
    expect((await miscSend("/user/keys/1")).status).toBe(401);
  });

  it("lists the doer's rows with pagination headers", async () => {
    await miscSend("/user/keys", authed(json({ title: "a", key: ED25519_KEY }, { method: "POST" })));
    await miscSend("/user/keys", authed(json({ title: "b", key: RSA_KEY }, { method: "POST" })));
    const response = await miscSend("/user/keys", authed());
    expect(response.status).toBe(200);
    const list = await response.json<Array<Record<string, unknown>>>();
    expect(list.map((key: Record<string, unknown>) => key.title)).toEqual(["a", "b"]);
    expect(list.map((key: Record<string, unknown>) => key.fingerprint)).toEqual([ED25519_FINGERPRINT, RSA_FINGERPRINT]);
    expect(response.headers.get("X-Total-Count")).toBe("2");
  });

  it("fingerprint is the unrestricted cross-user query (key.go:58-72)", async () => {
    await miscSend(
      "/user/keys",
      authed(json({ title: "neighbor-key", key: ED25519_KEY }, { method: "POST" }), TOKEN_NEIGHBOR),
    );
    const response = await miscSend(`/user/keys?fingerprint=${ED25519_FINGERPRINT}`, authed());
    expect(response.status).toBe(200);
    const list = await response.json<Array<Record<string, unknown>>>();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("neighbor-key");
    // The doer is not the owner and not an admin: no private information.
    expect(list[0]!.key_type).toBeUndefined();
    expect(list[0]!.user).toBeUndefined();
  });

  it("get by id is NOT owner-scoped; private information renders for owner/admin only", async () => {
    const created = await miscSend("/user/keys", authed(json({ title: "mine", key: ED25519_KEY }, { method: "POST" })));
    const keyId = (await created.json<Record<string, unknown>>()).id as number;
    const mine = await miscSend(`/user/keys/${keyId}`, authed());
    expect(mine.status).toBe(200);
    expect((await mine.json<Record<string, unknown>>()).key_type).toBe("user");

    const other = await miscSend(`/user/keys/${keyId}`, authed(undefined, TOKEN_NEIGHBOR));
    expect(other.status).toBe(200);
    const otherBody = await other.json<Record<string, unknown>>();
    expect(otherBody.key_type).toBeUndefined();
    expect(otherBody.user).toBeUndefined();

    const admin = await miscSend(`/user/keys/${keyId}`, authed(undefined, TOKEN_ADMIN));
    expect((await admin.json<Record<string, unknown>>()).key_type).toBe("user");

    expect((await miscSend("/user/keys/999", authed())).status).toBe(404);
  });
});

describe("DELETE /user/keys/{id} (misc-t3)", () => {
  it("403s a non-owner non-admin, 204s the owner, then 404s the miss", async () => {
    const created = await miscSend("/user/keys", authed(json({ title: "mine", key: ED25519_KEY }, { method: "POST" })));
    const keyId = (await created.json<Record<string, unknown>>()).id as number;

    const forbidden = await miscSend(`/user/keys/${keyId}`, authed({ method: "DELETE" }, TOKEN_NEIGHBOR));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json<Record<string, unknown>>()).message).toBe("You do not have access to this key");

    expect((await miscSend(`/user/keys/${keyId}`, authed({ method: "DELETE" }))).status).toBe(204);
    expect((await miscSend(`/user/keys/${keyId}`, authed({ method: "DELETE" }))).status).toBe(404);
    expect((await miscSend("/user/keys/999", authed({ method: "DELETE" }))).status).toBe(404);
  });

  it("an admin may delete another user's key", async () => {
    const created = await miscSend("/user/keys", authed(json({ title: "mine", key: ED25519_KEY }, { method: "POST" })));
    const keyId = (await created.json<Record<string, unknown>>()).id as number;
    expect((await miscSend(`/user/keys/${keyId}`, authed({ method: "DELETE" }, TOKEN_ADMIN))).status).toBe(204);
  });
});

describe("admin key arms (misc-t3)", () => {
  it("POST /admin/users/{username}/keys requires a site admin (403 body exact)", async () => {
    const response = await miscSend(
      "/admin/users/neighbor/keys",
      authed(json({ title: "k", key: ED25519_KEY }, { method: "POST" })),
    );
    expect(response.status).toBe(403);
    expect((await response.json<Record<string, unknown>>()).message).toBe("user should be the site admin");
    expect((await miscSend("/admin/users/neighbor/keys", authed({ method: "POST" }, TOKEN_NEIGHBOR))).status).toBe(403);
    expect((await miscSend("/admin/users/neighbor/keys", authed(json({ title: "k", key: ED25519_KEY }, { method: "POST" })))).status).toBe(403);
  });

  it("POST creates the key on the target user (admin render); 422 arms map", async () => {
    const created = await miscSend(
      "/admin/users/neighbor/keys",
      authed(json({ title: "by-admin", key: ED25519_KEY }, { method: "POST" }), TOKEN_ADMIN),
    );
    expect(created.status).toBe(201);
    const body = await created.json<Record<string, unknown>>();
    expect(body.title).toBe("by-admin");
    expect(body.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(body.key_type).toBe("user");
    expect((body.user as Record<string, unknown>).login).toBe("neighbor");

    const invalid = await miscSend(
      "/admin/users/neighbor/keys",
      authed(json({ title: "k", key: "garbage" }, { method: "POST" }), TOKEN_ADMIN),
    );
    expect(invalid.status).toBe(422);

    const duplicate = await miscSend(
      "/admin/users/neighbor/keys",
      authed(json({ title: "by-admin", key: ED25519_KEY }, { method: "POST" }), TOKEN_ADMIN),
    );
    expect(duplicate.status).toBe(422);
    expect((await duplicate.json<Record<string, unknown>>()).message).toBe("Key content has been used as non-deploy key");
  });

  it("the unknown-username miss 404s with the UserAssignmentAPI body (runtime-only-undeclared)", async () => {
    const response = await miscSend(
      "/admin/users/ghost/keys",
      authed(json({ title: "k", key: ED25519_KEY }, { method: "POST" }), TOKEN_ADMIN),
    );
    expect(response.status).toBe(404);
    expect((await response.json<Record<string, unknown>>()).message).toBe("user redirect does not exist [name: ghost]");
  });

  it("DELETE /admin/users/{username}/keys/{id} removes the target's key; miss 404s", async () => {
    const created = await miscSend(
      "/admin/users/neighbor/keys",
      authed(json({ title: "by-admin", key: ED25519_KEY }, { method: "POST" }), TOKEN_ADMIN),
    );
    const keyId = (await created.json<Record<string, unknown>>()).id as number;
    expect(
      (await miscSend(`/admin/users/neighbor/keys/${keyId}`, authed({ method: "DELETE" }, TOKEN_ADMIN))).status,
    ).toBe(204);
    expect(
      (await miscSend(`/admin/users/neighbor/keys/${keyId}`, authed({ method: "DELETE" }, TOKEN_ADMIN))).status,
    ).toBe(404);
    expect((await miscSend(`/admin/users/ghost/keys/${keyId}`, authed({ method: "DELETE" }, TOKEN_ADMIN))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GPG keys (user/gpg_key.go over gpg_keys)
// ---------------------------------------------------------------------------

describe("POST /user/gpg_keys (misc-t3)", () => {
  it("401s anonymous callers (contract-declared)", async () => {
    const response = await miscSend("/user/gpg_keys", json({ armored_public_key: GPG_MATCH }, { method: "POST" }));
    expect(response.status).toBe(401);
    expect((await response.json<Record<string, unknown>>()).message).toBe("token is required");
  });

  it("404s when no activated address matches the key identities (ErrGPGNoEmailFound)", async () => {
    const response = await miscSend(
      "/user/gpg_keys",
      authed(json({ armored_public_key: GPG_MATCH }, { method: "POST" })),
    );
    expect(response.status).toBe(404);
    const body = await response.json<Record<string, unknown>>();
    expect(String(body.message)).toMatch(
      /^None of the emails attached to the GPG key could be found\. It may still be added if you provide a valid signature for the token: [0-9a-f]{64}$/,
    );
  });

  it("creates the key once an activated address matches; full upstream render", async () => {
    await addEmail("gpg-match@example.com");
    const response = await miscSend(
      "/user/gpg_keys",
      authed(json({ armored_public_key: GPG_MATCH }, { method: "POST" })),
    );
    expect(response.status).toBe(201);
    const body = await response.json<Record<string, unknown>>();
    expect(body.id).toBe(1);
    expect(body.key_id).toBe(GPG_MATCH_KEY_ID);
    expect(body.primary_key_id).toBe("");
    // content = base64 of the canonical 0x99-framed v4 public-key packet
    // (upstream Base64EncPubKey) — not the armor.
    const packet = atob(body.public_key as string);
    const bytes = new Uint8Array(packet.length);
    for (let i = 0; i < packet.length; i++) bytes[i] = packet.charCodeAt(i);
    expect(bytes[0]).toBe(0x99);
    expect(bytes[3]).toBe(4); // v4
    expect(body.emails).toEqual([]);
    expect(body.subkeys).toEqual([]);
    expect(body.can_sign).toBe(true);
    expect(body.can_encrypt_comms).toBe(true);
    expect(body.can_encrypt_storage).toBe(true);
    expect(body.can_certify).toBe(true);
    expect(body.verified).toBe(false); // verification is not implemented
    expect(body.created_at).toBe(GPG_MATCH_CREATED);
    expect(body.expires_at).toBe(GO_ZERO);

    const duplicate = await miscSend(
      "/user/gpg_keys",
      authed(json({ armored_public_key: GPG_MATCH }, { method: "POST" })),
    );
    expect(duplicate.status).toBe(422);
    expect((await duplicate.json<Record<string, unknown>>()).message).toBe("A key with the same id already exists");
  });

  it("the signature arm answers the upstream invalid-token-signature 422 (verification unimplemented)", async () => {
    await addEmail("gpg-match@example.com");
    const response = await miscSend(
      "/user/gpg_keys",
      authed(json({ armored_public_key: GPG_MATCH, armored_signature: "not-a-signature" }, { method: "POST" })),
    );
    expect(response.status).toBe(422);
    expect(String((await response.json<Record<string, unknown>>()).message)).toMatch(
      /^The provided GPG key, signature and token do not match or token is out of date\. Provide a valid signature for the token: [0-9a-f]{64}$/,
    );
  });

  it("422s unparseable armor with the ErrGPGKeyParsing prefix; empty key 422s Required", async () => {
    const garbage = await miscSend("/user/gpg_keys", authed(json({ armored_public_key: "not armor" }, { method: "POST" })));
    expect(garbage.status).toBe(422);
    expect(String((await garbage.json<Record<string, unknown>>()).message)).toContain("failed to parse gpg key");

    const missing = await miscSend("/user/gpg_keys", authed(json({ armored_signature: "sig" }, { method: "POST" })));
    expect(missing.status).toBe(422);
    expect((await missing.json<Record<string, unknown>>()).message).toBe("ArmoredKey: Required");
  });

  it("stores subkeys as rows (primary_key_id set) and renders them nested", async () => {
    await addEmail("gpg-sub@example.com");
    const created = await miscSend(
      "/user/gpg_keys",
      authed(json({ armored_public_key: GPG_SUBKEYED }, { method: "POST" })),
    );
    expect(created.status).toBe(201);
    const body = await created.json<Record<string, unknown>>();
    expect(body.key_id).toBe(GPG_SUBKEYED_PRIMARY_KEY_ID);
    const subkeys = body.subkeys as Record<string, unknown>[];
    expect(subkeys).toHaveLength(1);
    expect(subkeys[0]!.key_id).toBe(GPG_SUBKEYED_SUBKEY_KEY_ID);
    expect(subkeys[0]!.primary_key_id).toBe(GPG_SUBKEYED_PRIMARY_KEY_ID);
    expect(subkeys[0]!.subkeys).toEqual([]);

    const listed = await miscSend("/user/gpg_keys", authed());
    expect(listed.headers.get("X-Total-Count")).toBe("1"); // subkeys are not top-level

    const got = await miscSend(`/user/gpg_keys/${String(body.id)}`, authed());
    expect(got.status).toBe(200);
    expect((await got.json<Record<string, unknown>>()).key_id).toBe(GPG_SUBKEYED_PRIMARY_KEY_ID);
  });
});

describe("GET /user/gpg_keys[/{id}] (misc-t3)", () => {
  it("lists the doer's primary keys with subkeys attached", async () => {
    await addEmail("gpg-sub@example.com");
    await miscSend("/user/gpg_keys", authed(json({ armored_public_key: GPG_SUBKEYED }, { method: "POST" })));
    await addEmail("gpg-match@example.com");
    await miscSend("/user/gpg_keys", authed(json({ armored_public_key: GPG_MATCH }, { method: "POST" })));

    const response = await miscSend("/user/gpg_keys", authed());
    expect(response.status).toBe(200);
    const list = await response.json<Array<Record<string, unknown>>>();
    expect(list.map((key: Record<string, unknown>) => key.key_id)).toEqual([GPG_SUBKEYED_PRIMARY_KEY_ID, GPG_MATCH_KEY_ID]);
    expect((list[0]!.subkeys as unknown[]).length).toBe(1);
    expect(list[1]!.subkeys).toEqual([]);
    expect(response.headers.get("X-Total-Count")).toBe("2");
  });

  it("get is owner-scoped (upstream GetGPGKeyForUserByID); the miss 404s", async () => {
    await addEmail("gpg-match@example.com");
    const created = await miscSend(
      "/user/gpg_keys",
      authed(json({ armored_public_key: GPG_MATCH }, { method: "POST" })),
    );
    const keyId = (await created.json<Record<string, unknown>>()).id as number;

    expect((await miscSend(`/user/gpg_keys/${keyId}`, authed(undefined, TOKEN_NEIGHBOR))).status).toBe(404);
    expect((await miscSend("/user/gpg_keys/999", authed())).status).toBe(404);
    expect((await miscSend(`/user/gpg_keys/${keyId}`, authed())).status).toBe(200);
  });
});

describe("DELETE /user/gpg_keys/{id} (misc-t3)", () => {
  it("removes the key AND its subkey rows; any unowned/missing id answers 204 (upstream nil-on-miss)", async () => {
    await addEmail("gpg-sub@example.com");
    const created = await miscSend(
      "/user/gpg_keys",
      authed(json({ armored_public_key: GPG_SUBKEYED }, { method: "POST" })),
    );
    const primaryId = (await created.json<Record<string, unknown>>()).id as number;

    // Unowned/missing ids are the upstream silent 204 (gpg_key.go:227-233) —
    // the corrected stub behavior (the landed 404 miscited VerifyUserGPGKey).
    expect((await miscSend("/user/gpg_keys/999", authed({ method: "DELETE" }))).status).toBe(204);
    expect((await miscSend(`/user/gpg_keys/${primaryId}`, authed({ method: "DELETE" }, TOKEN_NEIGHBOR))).status).toBe(204);
    expect((await miscSend(`/user/gpg_keys/${primaryId}`, authed())).status).toBe(200);

    expect((await miscSend(`/user/gpg_keys/${primaryId}`, authed({ method: "DELETE" }))).status).toBe(204);
    // The subkey rows went with the primary.
    const listed = await miscSend("/user/gpg_keys", authed());
    expect(await listed.json()).toEqual([]);
    expect((await miscSend(`/user/gpg_keys/${primaryId}`, authed())).status).toBe(404);
  });
});

describe("GET /user/gpg_key_token (misc-t3)", () => {
  it("returns the VerificationToken(doer, 1) sha256 formula as text/plain", async () => {
    const response = await miscSend("/user/gpg_key_token", authed());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    const token = await response.text();

    // Recompute the upstream formula (gpg_key_verify.go:78-86) with a
    // ±minute drift band so the assertion survives a minute rollover.
    const pad = (n: number) => String(n).padStart(2, "0");
    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const rfc = (d: Date) =>
      `${WEEKDAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
    const minuteStart = Math.floor(Date.now() / 60000) * 60000;
    const candidates: string[] = [];
    for (const drift of [-60000, 0, 60000]) {
      const payload = [
        rfc(new Date(minuteStart + drift + 60000)),
        rfc(new Date(0)), // the seed user's created_at
        "cf-gitea-stub",
        "",
        "1",
      ].join(":");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
      candidates.push([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    }
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(candidates).toContain(token);

    expect((await miscSend("/user/gpg_key_token")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Admin email listings (admin/email.go over SearchEmails + synth primaries)
// ---------------------------------------------------------------------------

describe("admin email listings (misc-t3)", () => {
  it("403s non-admins with the reqSiteAdmin body; anonymous 401s", async () => {
    expect((await miscSend("/admin/emails", authed())).status).toBe(403);
    expect((await miscSend("/admin/emails/search", authed({ }, TOKEN_NEIGHBOR))).status).toBe(403);
    expect((await miscSend("/admin/emails")).status).toBe(401);
  });

  it("lists every address with its owner (rows + synthesized primaries)", async () => {
    await env.DB.prepare("UPDATE users SET email = 'primary@example.com' WHERE id = 1").run();
    await addEmail("alt@example.com");
    await miscSend(
      "/user/emails",
      authed(json({ emails: ["neighbor@example.com"] }, { method: "POST" }), TOKEN_NEIGHBOR),
    );

    const response = await miscSend("/admin/emails", authed(undefined, TOKEN_ADMIN));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { email: "alt@example.com", verified: true, primary: false, user_id: 1, username: "cf-gitea-stub" },
      { email: "neighbor@example.com", verified: true, primary: false, user_id: neighborId, username: "neighbor" },
      { email: "primary@example.com", verified: true, primary: true, user_id: 1, username: "cf-gitea-stub" },
    ]);
    expect(response.headers.get("X-Total-Count")).toBe("3");
  });

  it("search filters by the q keyword (email, username, full name)", async () => {
    await env.DB.prepare("UPDATE users SET email = 'primary@example.com', full_name = 'Zed' WHERE id = 1").run();
    await addEmail("alt@example.com");
    await miscSend(
      "/user/emails",
      authed(json({ emails: ["neighbor@example.com"] }, { method: "POST" }), TOKEN_NEIGHBOR),
    );

    for (const [q, expected] of [
      ["prim", ["primary@example.com"]],
      ["neighbor@", ["neighbor@example.com"]],
      ["zed", ["alt@example.com", "primary@example.com"]], // full_name match (both rows belong to the user)
      ["cf-gitea", ["alt@example.com", "primary@example.com"]], // username match
    ] as const) {
      const response = await miscSend(`/admin/emails/search?q=${encodeURIComponent(q)}`, authed(undefined, TOKEN_ADMIN));
      expect(response.status).toBe(200);
      const list = await response.json<Array<Record<string, unknown>>>();
      expect(list.map((entry: Record<string, unknown>) => entry.email)).toEqual(expected);
    }
  });
});
