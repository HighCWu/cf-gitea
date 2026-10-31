/**
 * The Terraform state-backend ROUTE battery (SPEC-0016 §7's long-tail
 * `terraform` row) on real D1 + the real REPO_PACKS binding — upstream
 * routers/api/packages/terraform/terraform.go at the pin, through the REAL
 * mount shape (the packages-go.test.ts precedent: index.ts mounts the
 * sub-app at /api/packages):
 *
 *  - the arms: POST /:user/terraform/state/:name (201), the GET latest +
 *    GET versions/{serial} pair (byte parity, the D-6 disposition, the
 *    HEAD ride), DELETE (200), DELETE versions/{serial} (204, the
 *    latest-serial 403 text), POST lock (200), DELETE lock (200);
 *  - the EMPTY-body 404s (the nil-error ProcessErrorForUser shape —
 *    content-type text/plain;charset=utf-8 + nosniff, zero-length body);
 *  - the 423 LOCK shape: the upload's mismatched-ID refusal and the lock
 *    re-acquisition answer the CURRENT lock JSON with the Go struct field
 *    order (ID/Operation/Info/Who/Version/Created/Path), content-type
 *    application/json;charset=utf-8; the unlock mismatch is the PLAIN
 *    "lock ID mismatch" 423;
 *  - the allocation arm: POST lock on a NEVER-UPLOADED name allocates the
 *    `terraform` package with zero versions;
 *  - the gates: anonymous write → 401 + the Basic challenge, anonymous read
 *    of a public owner → 200, PACKAGES_ENABLED=false → 404, the size quota
 *    403 with the admin bypass.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, packages, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "personal_access_tokens",
    "auth_failures",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const prefix of ["packages/tmp/", "packages/blobs/"]) {
    const listed = await env.REPO_PACKS.list({ prefix });
    await env.REPO_PACKS.delete(listed.objects.map((object) => object.key));
  }
});

const db = () => drizzle(env.DB);

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; visibility?: "public" | "limited" | "private" } = {},
): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: "user",
      visibility: opts.visibility ?? "public",
      createdAt: new Date("2026-10-31T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

async function token(user: SeededUser, scopes: string): Promise<string> {
  return (await mintFor(user.id, `pat-${scopes}`, scopes)).plaintext;
}

const authHeaders = (plaintext: string): Record<string, string> => ({
  Authorization: `token ${plaintext}`,
});

/** The REAL mount shape: index.ts mounts the sub-app at /api/packages. */
function protocol(overrides: Record<string, string> = {}) {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createEcosystemProtocolRouter());
  const boundEnv = { ...env, ...overrides };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
}

const encoder = new TextEncoder();

function stateBody(serial: number, lineage = "9b5d3cf1-6f0a-4a2e-9a1b-0c2d3e4f5a6b"): Uint8Array {
  return encoder.encode(
    JSON.stringify({ version: 4, terraform_version: "1.9.0", serial, lineage, outputs: {}, resources: [] }),
  );
}

const NAME = "prod-network";

async function postState(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  user: string,
  serial: number,
  auth?: Record<string, string>,
  query = "",
): Promise<Response> {
  const bytes = stateBody(serial);
  return call(`/api/packages/${user}/terraform/state/${NAME}${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...(auth ?? {}) },
    body: bytes.slice() as unknown as BodyInit,
  });
}

// ---------------------------------------------------------------------------
// The endpoint round-trip
// ---------------------------------------------------------------------------

describe("terraform state routes (api.go:466-476)", () => {
  it("the full state lifecycle: upload 201 → latest 200 → by-serial 200 → delete-by-serial 204/403 → delete 200 → 404", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);

    const first = await postState(call, "alice", 1, auth);
    expect(first.status).toBe(201);
    await first.text();
    const second = await postState(call, "alice", 2, auth);
    expect(second.status).toBe(201);
    await second.text();

    // The latest read: byte parity + the family disposition.
    const latest = await call(`/api/packages/alice/terraform/state/${NAME}`, { headers: auth });
    expect(latest.status).toBe(200);
    expect(new Uint8Array(await latest.arrayBuffer())).toEqual(stateBody(2));

    // The by-serial read.
    const serial1 = await call(`/api/packages/alice/terraform/state/${NAME}/versions/1`, { headers: auth });
    expect(serial1.status).toBe(200);
    expect(new Uint8Array(await serial1.arrayBuffer())).toEqual(stateBody(1));

    // HEAD rides the GET walk with no body.
    const head = await call(`/api/packages/alice/terraform/state/${NAME}`, { method: "HEAD", headers: auth });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // The version counter bumped on the two GETs only.
    const versions = await db().select().from(packageVersions).all();
    const bumped = versions.find((row) => row.version === "2");
    expect(bumped?.downloadCount).toBe(1);

    // The LATEST serial delete is the 403; the old serial deletes 204.
    const delLatest = await call(`/api/packages/alice/terraform/state/${NAME}/versions/2`, {
      method: "DELETE",
      headers: auth,
    });
    expect(delLatest.status).toBe(403);
    expect(await delLatest.text()).toBe("cannot delete the latest version");
    const delOld = await call(`/api/packages/alice/terraform/state/${NAME}/versions/1`, {
      method: "DELETE",
      headers: auth,
    });
    expect(delOld.status).toBe(204);
    await delOld.text();

    // The whole-state delete, then the empty-404.
    const delAll = await call(`/api/packages/alice/terraform/state/${NAME}`, { method: "DELETE", headers: auth });
    expect(delAll.status).toBe(200);
    await delAll.text();
    const gone = await call(`/api/packages/alice/terraform/state/${NAME}`, { headers: auth });
    expect(gone.status).toBe(404);
    expect(gone.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(gone.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await gone.arrayBuffer()).byteLength).toBe(0);

    const pkgs = await db().select().from(packages).all();
    expect(pkgs).toHaveLength(0);
  });

  it("the lock dance through the arms: allocate → 423 JSON on the mismatched upload → the ID-bearing upload → the unlock mismatch → unlock", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);

    // The lock ALLOCATES the package on a never-uploaded name.
    const lockBody = JSON.stringify({ ID: "lock-A", Operation: "OperationTypeApply", Who: "root@runner" });
    const lock = await call(`/api/packages/alice/terraform/state/${NAME}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: lockBody,
    });
    expect(lock.status).toBe(200);
    await lock.text();
    const allocated = await db().select().from(packages).all();
    expect(allocated).toHaveLength(1);
    expect(allocated[0]?.type).toBe("terraform");
    expect((await db().select().from(packageVersions).all()).length).toBe(0);

    // The upload without the lock ID → 423 with the CURRENT lock JSON in the
    // Go struct field order.
    const refused = await postState(call, "alice", 1, auth);
    expect(refused.status).toBe(423);
    expect(refused.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const refusedBody = await refused.json<Record<string, unknown>>();
    expect(Object.keys(refusedBody)).toEqual(["ID", "Operation", "Info", "Who", "Version", "Created", "Path"]);
    expect(refusedBody["ID"]).toBe("lock-A");
    expect(refusedBody["Operation"]).toBe("OperationTypeApply");
    expect(refusedBody["Who"]).toBe("root@runner");
    expect(refusedBody["Created"]).toBe("0001-01-01T00:00:00Z");

    // The ID-bearing upload passes.
    const allowed = await postState(call, "alice", 1, auth, "?ID=lock-A");
    expect(allowed.status).toBe(201);
    await allowed.text();

    // Re-locking is the 423 + current lock; the unlock mismatch is the PLAIN
    // 423; the right ID unlocks.
    const relock = await call(`/api/packages/alice/terraform/state/${NAME}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ ID: "lock-B" }),
    });
    expect(relock.status).toBe(423);
    expect((await relock.json<Record<string, unknown>>())["ID"]).toBe("lock-A");

    const mismatch = await call(`/api/packages/alice/terraform/state/${NAME}/lock`, {
      method: "DELETE",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ ID: "lock-B" }),
    });
    expect(mismatch.status).toBe(423);
    expect(await mismatch.text()).toBe("lock ID mismatch");

    const unlock = await call(`/api/packages/alice/terraform/state/${NAME}/lock`, {
      method: "DELETE",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ ID: "lock-A" }),
    });
    expect(unlock.status).toBe(200);
    await unlock.text();

    // The unlocked state deletes whole.
    const delAll = await call(`/api/packages/alice/terraform/state/${NAME}`, { method: "DELETE", headers: auth });
    expect(delAll.status).toBe(200);
    await delAll.text();
  });

  it("the lock arms' 400s: a bad name and an ID-less body answer before any allocation", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);

    // The space-bearing name arrives decoded ("a b") and fails the pattern.
    const badName = await call("/api/packages/alice/terraform/state/a%20b/lock", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ ID: "x" }),
    });
    expect(badName.status).toBe(400);
    await badName.text();

    const noId = await call(`/api/packages/alice/terraform/state/${NAME}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ Who: "root@runner" }),
    });
    expect(noId.status).toBe(400);
    await noId.text();

    const badUploadName = await call("/api/packages/alice/terraform/state/a%20b", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...auth },
      body: stateBody(1).slice() as unknown as BodyInit,
    });
    expect(badUploadName.status).toBe(400);
    await badUploadName.text();

    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("a same-serial re-post answers the 409 EMPTY-detail", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);
    expect((await postState(call, "alice", 3, auth)).status).toBe(201);
    const again = await postState(call, "alice", 3, auth);
    expect(again.status).toBe(409);
    expect(await again.text()).toBe("package file already exists");
  });

  it("a non-state body answers the 400 parse arm", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const bad = await call(`/api/packages/alice/terraform/state/${NAME}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...authHeaders(writer) },
      body: encoder.encode("not a state") as unknown as BodyInit,
    });
    expect(bad.status).toBe(400);
    await bad.text();
  });
});

// ---------------------------------------------------------------------------
// Auth / quota / the family switch
// ---------------------------------------------------------------------------

describe("terraform auth/quota arms", () => {
  it("an anonymous write is the 401 challenge; a PUBLIC owner's state reads anonymously", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();

    const anon = await postState(call, "alice", 1);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anon.text();

    expect((await postState(call, "alice", 1, authHeaders(writer))).status).toBe(201);
    const read = await call(`/api/packages/alice/terraform/state/${NAME}`);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(stateBody(1));

    // The anonymous lock write is the challenge too.
    const anonLock = await call(`/api/packages/alice/terraform/state/${NAME}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ID: "x" }),
    });
    expect(anonLock.status).toBe(401);
    await anonLock.text();
  });

  it("a PRIVATE owner's state is the stranger's 401 challenge (the go family posture), 200 for the owner's token", async () => {
    const stealth = await seedUser("stealth", { visibility: "private" });
    const writer = await token(stealth, "write:package");
    const call = protocol();
    expect((await postState(call, "stealth", 1, authHeaders(writer))).status).toBe(201);

    const stranger = await seedUser("stranger");
    const strangerToken = await token(stranger, "write:package");
    const denied = await call(`/api/packages/stealth/terraform/state/${NAME}`, { headers: authHeaders(strangerToken) });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await denied.text();

    const own = await call(`/api/packages/stealth/terraform/state/${NAME}`, { headers: authHeaders(writer) });
    expect(own.status).toBe(200);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(stateBody(1));
  });

  it("the size quota 403 with the admin bypass; PACKAGES_ENABLED=false 404s the family", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");
    const capped = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "1" });

    const denied = await postState(capped, "alice", 1, authHeaders(writer));
    expect(denied.status).toBe(403);
    await denied.text();

    const bypass = await postState(capped, "root", 1, authHeaders(adminWriter));
    expect(bypass.status).toBe(201);
    await bypass.text();

    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const dead = await postState(disabled, "alice", 1, authHeaders(writer));
    expect(dead.status).toBe(404);
    await dead.text();
  });
});
