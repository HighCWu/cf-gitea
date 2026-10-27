/**
 * The repo deploy-key family (routes/deploy-keys.ts — the inventory's
 * `wave-api-deploy-keys` batch) on real D1 (migration 0020's `deploy_keys` +
 * the shared `public_keys` store): all five contract ops over the
 * standalone-mount convention (the routes ARE registered in router.ts by the
 * orchestrator after this batch).
 *
 * Per-arm contract verification: every DECLARED response code of every op is
 * exercised — list {200,404}, get {200,404}, create {201,404,422}, tokens
 * {201,404,422}, delete {204,403,404}. (The delete's declared 403/404 are
 * exercised through the gates that emit them: reqRepoAdmin's 403 and the
 * anti-enumeration repo 404; the KEY-miss arm itself 204s — upstream's
 * idempotent delete, key.go:311-317.) The runtime-only 401/403 codes stay
 * undeclared per the module header, asserted as behavior, not contract.
 *
 * The storage split is pinned end-to-end: an SSH deploy key shares ONE
 * `public_keys` row (type=2, mode=0, owner = the -3 system principal the FK
 * needs) across every repo that adds the content, and the last delete
 * removes it; a deploy token stores only the sha256 hash and returns the
 * `gdt_…` plaintext exactly once.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { deployKeys, publicKeys, repoCollaborators, repositories, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerDeployKeyRoutes } from "./deploy-keys";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["deploy_keys", "public_keys", "repo_collaborators", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, isAdmin, type] of [
    [1, "doer", 0, "user"], // a plain authenticated non-admin
    [2, "bob", 0, "user"], // an admin-mode collaborator (the no-repository arm)
    [3, "chief", 1, "user"], // site admin
    [4, "alice", 0, "user"], // the repo owner (the family's admin)
    [20, "acme", 0, "org"], // the org owner
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, ?, 'active', ?, 0)")
      .bind(id, username, username, isAdmin, type)
      .run();
  }
});

const db = () => drizzle(env.DB);

// Test key material — the misc-t3.test.ts pair (fingerprints pre-pinned there
// through the shared parser this family reuses).
const ED25519_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICQgLhusngED6SvOcMDWHg9wVjgOJ4QTN77gPol4OtTU ed25519-comment user@host";
const ED25519_FINGERPRINT = "SHA256:nBIbxZfae58Hod5zlVgetQGtfn2OhEymkNryw9sEXR8";
const RSA_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC3sBogtkFTvHdp6XkAThDF9Xqbfri5C/mGWrH4vnwBhnWFULjS5Kcu9Sk1Rz0FsCvnsEG9Fnbkaq9g28Wv7QZZsWmkC+UfvSoMVIt3koKLYwweRv3do/TzL/2KT5BBGTSCUGeotpkP8znF3fK6xi7A7zf9cBzfL8P2tNnLR+XqgGfVuRFjVXd2wjjtpEhOHLK4BIncKpoI6TgIHwFayxH+DrNQDTjpCw7NWef5jsstb0ICBRQti5QNc+uYm1qQPDTsZ8ZlljnOxy/4Au6aPXpq2jUHQWfBFy+IrVeVEoGIacrBMK5aAjS/aHDIKDVql0km8r8BMFlfNDD/Lff5v59f";
const RSA_FINGERPRINT = "SHA256:I5plbz5CJDzZiBSGXjZBVDpAS8c0FI3jzxrjbQSfaaU";

const OWNER_TOKEN = "token-alice"; // the repo owner
const DOER_TOKEN = "token-doer"; // a plain authenticated user
const COLLAB_TOKEN = "token-bob"; // an admin-mode collaborator
const ADMIN_TOKEN = "token-chief"; // the site admin

const IDENTITY_TOKENS: Record<string, { id: number; login: string; is_admin: boolean }> = {
  [OWNER_TOKEN]: { id: 4, login: "alice", is_admin: false },
  [DOER_TOKEN]: { id: 1, login: "doer", is_admin: false },
  [COLLAB_TOKEN]: { id: 2, login: "bob", is_admin: false },
  [ADMIN_TOKEN]: { id: 3, login: "chief", is_admin: true },
};

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(IDENTITY_TOKENS[token] ?? null) };

/** Local mount of the orchestrator's registration seam (requireAuth only —
 *  the whole family is reqToken+reqAdmin upstream). The registry paths are
 *  relative to the /api/v1 mount, so fetched paths strip the prefix. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerDeployKeyRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const authed = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}`, "Content-Type": "application/json" },
});

const post = (path: string, body: unknown, token = OWNER_TOKEN): Promise<Response> =>
  router()(path, authed(token, { method: "POST", body: JSON.stringify(body) }));
const del = (path: string, token = OWNER_TOKEN): Promise<Response> => router()(path, authed(token, { method: "DELETE" }));
const get = (path: string, token = OWNER_TOKEN): Promise<Response> => router()(path, authed(token, { method: "GET" }));

async function jsonBody<T extends object = Record<string, unknown>>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

/** The create arms' id-bearing slice (list/get/delete URL building). */
interface CreatedKey {
  id: number;
  key_id: number;
}

let repoSeq = 8600;

/** One user-owned repo (alice/visibleN, public, not archived). */
async function seedRepo(ownerNamespace = "alice", ownerId = 4): Promise<{ slug: string; repoId: string }> {
  const repoId = String(repoSeq++);
  const slug = `visible${repoId}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  return { slug, repoId };
}

/** The deploy_keys row count for a repo (raw — asserts the storage split). */
const deployRowCount = async (repoId: string): Promise<number> =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM deploy_keys WHERE repo_id = ?").bind(repoId).first<{ n: number }>())!.n;

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// repoCreateKey — POST /repos/{owner}/{repo}/keys
// ---------------------------------------------------------------------------

describe("repoCreateKey (POST /repos/{owner}/{repo}/keys)", () => {
  it("201: creates an ssh deploy key, the shared public_keys row under the system principal", async () => {
    const { slug, repoId } = await seedRepo();
    const res = await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY });
    expect(res.status).toBe(201);
    const body = await jsonBody<{
      id: number;
      key_id: number;
      key_type: string;
      key: string;
      title: string;
      fingerprint: string;
      read_only: boolean;
      created_at: string;
      url: string;
    }>(res);
    expect(body.key_type).toBe("ssh");
    expect(body.key).toBe(ED25519_KEY);
    expect(body.title).toBe("ci");
    expect(body.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(body.read_only).toBe(false);
    expect(body.created_at).toBe(new Date(body.created_at).toISOString());
    expect(body.url).toBe(`https://example.com/api/v1/repos/alice/${slug}/keys/${body.id}`);
    expect(body.key_id).toBeGreaterThan(0);
    // The create response carries no repository / token field (both omitempty).
    expect(body).not.toHaveProperty("repository");
    expect(body).not.toHaveProperty("token");

    // Storage split: one deploy row (write mode) + ONE shared public_keys row
    // (type=2, mode=0, "(DeployKey)", owner -3 — the FK adaptation).
    expect(await deployRowCount(repoId)).toBe(1);
    const pkey = (await db().select().from(publicKeys).where(eq(publicKeys.id, body.key_id)).all())[0]!;
    expect(pkey.type).toBe(2);
    expect(pkey.mode).toBe(0);
    expect(pkey.name).toBe("(DeployKey)");
    expect(pkey.ownerId).toBe(-3);
    expect(pkey.fingerprint).toBe(ED25519_FINGERPRINT);
    const deployRow = (await db().select().from(deployKeys).where(eq(deployKeys.repoId, repoId)).all())[0]!;
    expect(deployRow.keyType).toBe(1);
    expect(deployRow.mode).toBe(2);
    expect(deployRow.keyId).toBe(body.key_id);
    expect(deployRow.tokenHash).toBe("");
  });

  it("201: read_only lands mode 1 and renders read_only true", async () => {
    const { slug } = await seedRepo();
    const res = await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ro", key: ED25519_KEY, read_only: true });
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.read_only).toBe(true);
    const deployRow = (await db().select().from(deployKeys).all())[0]!;
    expect(deployRow.mode).toBe(1);
  });

  it("201: the same content in a second repo reuses ONE public_keys row", async () => {
    const first = await seedRepo();
    const second = await seedRepo();
    const r1 = await jsonBody(await post(`/api/v1/repos/alice/${first.slug}/keys`, { title: "ci", key: ED25519_KEY }));
    const res2 = await post(`/api/v1/repos/alice/${second.slug}/keys`, { title: "ci2", key: ED25519_KEY });
    expect(res2.status).toBe(201);
    const body2 = await jsonBody(res2);
    expect(r1.key_id).toBe(body2.key_id); // the shared row
    expect(await deployRowCount(first.repoId)).toBe(1);
    expect(await deployRowCount(second.repoId)).toBe(1);
    expect((await db().select().from(publicKeys).all()).length).toBe(1);
  });

  it("422: invalid key content (the shared parser's 422 family)", async () => {
    const { slug } = await seedRepo();
    const res = await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: "not-a-key" });
    expect(res.status).toBe(422);
    const body = await jsonBody(res);
    expect(String(body.message)).toMatch(/^Invalid key content: /);
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: "-----BEGIN PUBLIC KEY-----" })).status).toBe(422);
  });

  it("422: the Go binder's required-field texts", async () => {
    const { slug } = await seedRepo();
    const noTitle = await jsonBody(await post(`/api/v1/repos/alice/${slug}/keys`, { key: ED25519_KEY }));
    expect(noTitle.message).toBe("Title: Required");
    const noKey = await jsonBody(await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci" }));
    expect(noKey.message).toBe("Key: Required");
  });

  it("422: key content already used as a non-deploy (user) key", async () => {
    const { slug } = await seedRepo();
    await db().insert(publicKeys).values({
      ownerId: 4,
      name: "personal",
      fingerprint: ED25519_FINGERPRINT,
      content: ED25519_KEY,
      mode: 2,
      type: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const res = await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("Key content has been used as non-deploy key");
  });

  it("422: the (repo, key) pair already added", async () => {
    const { slug } = await seedRepo();
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY })).status).toBe(201);
    const res = await post(`/api/v1/repos/alice/${slug}/keys`, { title: "other-name", key: ED25519_KEY });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("This key has already been added to this repository");
  });

  it("422: the name is taken within the repo, free in another repo", async () => {
    const first = await seedRepo();
    const second = await seedRepo();
    expect((await post(`/api/v1/repos/alice/${first.slug}/keys`, { title: "ci", key: ED25519_KEY })).status).toBe(201);
    const taken = await post(`/api/v1/repos/alice/${first.slug}/keys`, { title: "ci", key: RSA_KEY });
    expect(taken.status).toBe(422);
    expect((await jsonBody(taken)).message).toBe("A key with the same name already exists");
    // Upstream's checkDeployKeyName is per-repo — the same title lands elsewhere.
    expect((await post(`/api/v1/repos/alice/${second.slug}/keys`, { title: "ci", key: RSA_KEY })).status).toBe(201);
    expect((await db().select().from(publicKeys).all()).length).toBe(2);
  });

  it("404: unknown repo (the anti-enumeration arm)", async () => {
    const res = await post("/api/v1/repos/alice/ghost/keys", { title: "ci", key: ED25519_KEY });
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toBe("not found");
  });

  it("403: a non-admin doer (upstream reqAdmin — runtime-only, undeclared)", async () => {
    const { slug } = await seedRepo();
    const res = await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY }, DOER_TOKEN);
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).message).toBe("user should be an owner or a collaborator with admin write of a repository");
  });

  it("401: anonymous callers (upstream reqToken — runtime-only, undeclared)", async () => {
    const { slug } = await seedRepo();
    const res = await router()(`/api/v1/repos/alice/${slug}/keys`, { method: "POST", body: JSON.stringify({ title: "ci", key: ED25519_KEY }) });
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).message).toBe("token is required");
  });
});

// ---------------------------------------------------------------------------
// repoCreateDeployToken — POST /repos/{owner}/{repo}/keys/tokens
// ---------------------------------------------------------------------------

describe("repoCreateDeployToken (POST /repos/{owner}/{repo}/keys/tokens)", () => {
  it("201: creates a gdt_ token, hash-only storage, masked fingerprint", async () => {
    const { slug, repoId } = await seedRepo();
    const res = await post(`/api/v1/repos/alice/${slug}/keys/tokens`, { title: "runner", read_only: true });
    expect(res.status).toBe(201);
    const body = await jsonBody<{
      token: string;
      key_type: string;
      key_id: number;
      key: string;
      read_only: boolean;
      fingerprint: string;
    }>(res);
    const token = body.token;
    expect(token).toMatch(/^gdt_[a-zA-Z0-9]{43}$/);
    expect(body.key_type).toBe("token");
    expect(body.key_id).toBe(0);
    expect(body.key).toBe("");
    expect(body.read_only).toBe(true);
    expect(body.fingerprint).toBe(`${token.slice(0, 6)}********${token.slice(-2)}`);
    expect(body).not.toHaveProperty("repository");

    const deployRow = (await db().select().from(deployKeys).where(eq(deployKeys.repoId, repoId)).all())[0]!;
    expect(deployRow.keyType).toBe(2);
    expect(deployRow.keyId).toBe(0);
    expect(deployRow.tokenHash).toBe(await sha256Hex(token));
    expect(deployRow.mode).toBe(1);
    // A token has no public key to add (deploy_key.go:47-49).
    expect((await db().select().from(publicKeys).all()).length).toBe(0);
  });

  it("201: write mode by default", async () => {
    const { slug } = await seedRepo();
    const body = await jsonBody(await post(`/api/v1/repos/alice/${slug}/keys/tokens`, { title: "runner" }));
    expect(body.read_only).toBe(false);
  });

  it("422: the binder's required and MaxSize(50) texts", async () => {
    const { slug } = await seedRepo();
    expect((await jsonBody(await post(`/api/v1/repos/alice/${slug}/keys/tokens`, {}))).message).toBe("Title: Required");
    const res = await post(`/api/v1/repos/alice/${slug}/keys/tokens`, { title: "x".repeat(51) });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("Title: MaxSize");
  });

  it("422: the name space is shared with ssh deploy keys", async () => {
    const { slug } = await seedRepo();
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY })).status).toBe(201);
    const res = await post(`/api/v1/repos/alice/${slug}/keys/tokens`, { title: "ci" });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("A key with the same name already exists");
  });

  it("404 / 403: the shared repo arms", async () => {
    expect((await post("/api/v1/repos/alice/ghost/keys/tokens", { title: "runner" })).status).toBe(404);
    const { slug } = await seedRepo();
    expect((await post(`/api/v1/repos/alice/${slug}/keys/tokens`, { title: "runner" }, DOER_TOKEN)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// repoListKeys — GET /repos/{owner}/{repo}/keys
// ---------------------------------------------------------------------------

describe("repoListKeys (GET /repos/{owner}/{repo}/keys)", () => {
  it("200: renders the contract DeployKey shape, name-ordered", async () => {
    const { slug, repoId } = await seedRepo();
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "b-key", key: RSA_KEY })).status).toBe(201);
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "a-key", key: ED25519_KEY })).status).toBe(201);
    await post(`/api/v1/repos/alice/${slug}/keys/tokens`, { title: "c-token", read_only: true });

    const res = await get(`/api/v1/repos/alice/${slug}/keys`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    const list = (await res.json<Record<string, unknown>[]>());
    // ToOrders → "name" (deploykey.go:86).
    expect(list.map((k) => k.title)).toEqual(["a-key", "b-key", "c-token"]);
    expect(list[0]!.key_type).toBe("ssh");
    expect(list[0]!.key).toBe(ED25519_KEY);
    expect(list[0]!.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(list[0]!.read_only).toBe(false);
    // The owner sees the embedded repository with the KEY's access mode
    // (a-key is a write key: push true; admin stays false — AccessMode 2).
    const repository = list[0]!.repository as Record<string, unknown>;
    expect(repository.full_name).toBe(`alice/${slug}`);
    expect(repository.id).toBe(Number(repoId));
    expect(repository.permissions).toEqual({ admin: false, push: true, pull: true });
    // Reads never carry the token (xorm:"-" + omitempty).
    expect(list[2]!.key_type).toBe("token");
    expect(list[2]!.token).toBeUndefined();
    expect(list[2]!.key_id).toBe(0);
    expect(list[2]!.key).toBe("");
    expect(list[2]!.read_only).toBe(true);
  });

  it("200: a collaborator-admin gets no repository field; the site admin does", async () => {
    const { slug } = await seedRepo();
    await db().insert(repoCollaborators).values({ repoId: (await db().select().from(repositories).all())[0]!.id, userId: 2, mode: "admin" });
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY })).status).toBe(201);

    const collabList = (await (await get(`/api/v1/repos/alice/${slug}/keys`, COLLAB_TOKEN)).json<Record<string, unknown>[]>());
    expect(collabList).toHaveLength(1);
    expect(collabList[0]!).not.toHaveProperty("repository");

    const adminList = (await (await get(`/api/v1/repos/alice/${slug}/keys`, ADMIN_TOKEN)).json<Record<string, unknown>[]>());
    expect(adminList[0]!).toHaveProperty("repository");
  });

  it("200: the read-only flag ranks the embedded repository's permissions push:false (both key types)", async () => {
    const { slug } = await seedRepo();
    // mode 1 (read-only) on both carriers — the flag arm's render boundary:
    // appendPrivateInformation (key.go:26-38) carries the KEY's access mode
    // into the permissions block, ToDeployKey rendering push as mode==2
    // (convert.go:908-925). The write-key push:true arm is the sibling test.
    expect(
      (await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ro-key", key: ED25519_KEY, read_only: true })).status,
    ).toBe(201);
    expect((await post(`/api/v1/repos/alice/${slug}/keys/tokens`, { title: "ro-token", read_only: true })).status).toBe(201);
    // A write ssh key beside them — the contrast arm on the same list.
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "rw-key", key: RSA_KEY })).status).toBe(201);

    const list = (await (await get(`/api/v1/repos/alice/${slug}/keys`)).json<Record<string, unknown>[]>());
    expect(list.map((k) => k.title)).toEqual(["ro-key", "ro-token", "rw-key"]); // ToOrders → name order
    expect(list[0]!.read_only).toBe(true);
    expect((list[0]!.repository as Record<string, unknown>).permissions).toEqual({ admin: false, push: false, pull: true });
    expect(list[1]!.read_only).toBe(true);
    expect((list[1]!.repository as Record<string, unknown>).permissions).toEqual({ admin: false, push: false, pull: true });
    expect(list[2]!.read_only).toBe(false);
    expect((list[2]!.repository as Record<string, unknown>).permissions).toEqual({ admin: false, push: true, pull: true });
  });

  it("200: the key_id and fingerprint filters narrow the list", async () => {
    const { slug } = await seedRepo();
    const first = await jsonBody<CreatedKey>(await post(`/api/v1/repos/alice/${slug}/keys`, { title: "a-key", key: ED25519_KEY }));
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "b-key", key: RSA_KEY })).status).toBe(201);

    const byId = (await (await get(`/api/v1/repos/alice/${slug}/keys?key_id=${first.key_id}`)).json<Record<string, unknown>[]>());
    expect(byId.map((k) => k.title)).toEqual(["a-key"]);
    const byFingerprint = (await (await get(`/api/v1/repos/alice/${slug}/keys?fingerprint=${encodeURIComponent(RSA_FINGERPRINT)}`)).json<Record<string, unknown>[]>());
    expect(byFingerprint.map((k) => k.title)).toEqual(["b-key"]);
    // Upstream's FormInt64: a non-integer key_id counts as 0 (unfiltered).
    const garbage = (await (await get(`/api/v1/repos/alice/${slug}/keys?key_id=abc`)).json<Record<string, unknown>[]>());
    expect(garbage).toHaveLength(2);
  });

  it("200: page/limit pagination", async () => {
    const { slug } = await seedRepo();
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "a-key", key: ED25519_KEY })).status).toBe(201);
    expect((await post(`/api/v1/repos/alice/${slug}/keys`, { title: "b-key", key: RSA_KEY })).status).toBe(201);
    const res = await get(`/api/v1/repos/alice/${slug}/keys?page=2&limit=1`);
    const list = (await res.json<Record<string, unknown>[]>());
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(list.map((k) => k.title)).toEqual(["b-key"]);
    expect(res.headers.get("Link")).toContain('rel="prev"');
  });

  it("200: an empty repo renders []", async () => {
    const { slug } = await seedRepo();
    const res = await get(`/api/v1/repos/alice/${slug}/keys`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("404 / 403 / 401: the shared arms", async () => {
    expect((await get("/api/v1/repos/alice/ghost/keys")).status).toBe(404);
    const { slug } = await seedRepo();
    expect((await get(`/api/v1/repos/alice/${slug}/keys`, DOER_TOKEN)).status).toBe(403);
    expect((await router()(`/api/v1/repos/alice/${slug}/keys`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// repoGetKey — GET /repos/{owner}/{repo}/keys/{id}
// ---------------------------------------------------------------------------

describe("repoGetKey (GET /repos/{owner}/{repo}/keys/{id})", () => {
  it("200: renders one key (no token field)", async () => {
    const { slug } = await seedRepo();
    const created = await jsonBody<CreatedKey>(await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY }));
    const res = await get(`/api/v1/repos/alice/${slug}/keys/${created.id}`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.id).toBe(created.id);
    expect(body.title).toBe("ci");
    expect(body.key).toBe(ED25519_KEY);
    expect(body).not.toHaveProperty("token");
  });

  it("200: a read-only key round-trips the flag on the single read (and explicit read_only:false stays write)", async () => {
    const { slug } = await seedRepo();
    const ro = await jsonBody<CreatedKey & { read_only: boolean }>(
      await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ro", key: ED25519_KEY, read_only: true }),
    );
    const rw = await jsonBody<CreatedKey & { read_only: boolean }>(
      await post(`/api/v1/repos/alice/${slug}/keys`, { title: "rw", key: RSA_KEY, read_only: false }),
    );
    // Explicit false lands write mode exactly like the absent default (the
    // handler's read_only === true arm — the flag's two-side boundary).
    expect(rw.read_only).toBe(false);
    // The single GET renders the flag off the stored row (convert.go:908-925)
    // with the owner's embedded repository reflecting the key's mode.
    const roGet = await get(`/api/v1/repos/alice/${slug}/keys/${ro.id}`);
    expect(roGet.status).toBe(200);
    const body = await jsonBody<{ read_only: boolean; repository: Record<string, unknown> }>(roGet);
    expect(body.read_only).toBe(true);
    expect(body.repository.permissions).toEqual({ admin: false, push: false, pull: true });
  });

  it("404: a foreign repo's key id is the same plain miss (repo-scoped lookup)", async () => {
    const first = await seedRepo();
    const second = await seedRepo();
    const created = await jsonBody<CreatedKey>(await post(`/api/v1/repos/alice/${first.slug}/keys`, { title: "ci", key: ED25519_KEY }));
    const res = await get(`/api/v1/repos/alice/${second.slug}/keys/${created.id}`);
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toBe(`Deploy key does not exist [id: ${created.id}, key_id: 0, repo_id: ${second.repoId}]`);
  });

  it("404: unknown and non-integer ids (PathParamInt64 → 0 → miss)", async () => {
    const { slug, repoId } = await seedRepo();
    const missing = await get(`/api/v1/repos/alice/${slug}/keys/999`);
    expect(missing.status).toBe(404);
    expect((await jsonBody(missing)).message).toBe(`Deploy key does not exist [id: 999, key_id: 0, repo_id: ${repoId}]`);
    expect((await get(`/api/v1/repos/alice/${slug}/keys/not-a-number`)).status).toBe(404);
  });

  it("404 / 403: the shared repo arms", async () => {
    expect((await get("/api/v1/repos/alice/ghost/keys/1")).status).toBe(404);
    const { slug } = await seedRepo();
    expect((await get(`/api/v1/repos/alice/${slug}/keys/1`, DOER_TOKEN)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// repoDeleteKey — DELETE /repos/{owner}/{repo}/keys/{id}
// ---------------------------------------------------------------------------

describe("repoDeleteKey (DELETE /repos/{owner}/{repo}/keys/{id})", () => {
  it("204: deletes the row; the shared public key survives while another repo references it", async () => {
    const first = await seedRepo();
    const second = await seedRepo();
    const r1 = await jsonBody<CreatedKey>(await post(`/api/v1/repos/alice/${first.slug}/keys`, { title: "ci", key: ED25519_KEY }));
    expect((await post(`/api/v1/repos/alice/${second.slug}/keys`, { title: "ci", key: ED25519_KEY })).status).toBe(201);

    const res = await del(`/api/v1/repos/alice/${first.slug}/keys/${r1.id}`);
    expect(res.status).toBe(204);
    expect(await deployRowCount(first.repoId)).toBe(0);
    expect(await deployRowCount(second.repoId)).toBe(1);
    // IsDeployKeyExistByPublicKeyID: still referenced → the public key stays.
    expect((await db().select().from(publicKeys).all()).length).toBe(1);
  });

  it("204: the last ssh reference takes the shared public_keys row with it", async () => {
    const { slug, repoId } = await seedRepo();
    const created = await jsonBody<CreatedKey>(await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY }));
    const res = await del(`/api/v1/repos/alice/${slug}/keys/${created.id}`);
    expect(res.status).toBe(204);
    expect(await deployRowCount(repoId)).toBe(0);
    expect((await db().select().from(publicKeys).all()).length).toBe(0);
  });

  it("204: a token delete cleans only the deploy row", async () => {
    const { slug, repoId } = await seedRepo();
    const created = await jsonBody<CreatedKey>(await post(`/api/v1/repos/alice/${slug}/keys/tokens`, { title: "runner" }));
    expect((await del(`/api/v1/repos/alice/${slug}/keys/${created.id}`)).status).toBe(204);
    expect(await deployRowCount(repoId)).toBe(0);
  });

  it("204: a missing key id still 204s (the idempotent-delete swallow, key.go:311-317)", async () => {
    const { slug } = await seedRepo();
    expect((await del(`/api/v1/repos/alice/${slug}/keys/424242`)).status).toBe(204);
    expect((await del(`/api/v1/repos/alice/${slug}/keys/not-a-number`)).status).toBe(204);
  });

  it("204: a foreign repo's key id is a miss → 204 (never deletes the other repo's row)", async () => {
    const first = await seedRepo();
    const second = await seedRepo();
    const created = await jsonBody<CreatedKey>(await post(`/api/v1/repos/alice/${first.slug}/keys`, { title: "ci", key: ED25519_KEY }));
    expect((await del(`/api/v1/repos/alice/${second.slug}/keys/${created.id}`)).status).toBe(204);
    expect(await deployRowCount(first.repoId)).toBe(1);
  });

  it("204 / 403 / 404: every declared arm", async () => {
    const { slug } = await seedRepo();
    const created = await jsonBody<CreatedKey>(await post(`/api/v1/repos/alice/${slug}/keys`, { title: "ci", key: ED25519_KEY }));
    // 404 — unknown repo (the anti-enumeration arm).
    expect((await del("/api/v1/repos/alice/ghost/keys/1")).status).toBe(404);
    // 403 — the non-admin (upstream reqAdmin).
    expect((await del(`/api/v1/repos/alice/${slug}/keys/${created.id}`, DOER_TOKEN)).status).toBe(403);
    // 204 — the happy delete.
    expect((await del(`/api/v1/repos/alice/${slug}/keys/${created.id}`)).status).toBe(204);
    const after = (await db().select().from(users).where(eq(users.id, -3)).all()).length;
    expect(after).toBe(1); // the system principal row survives deletes
  });
});
