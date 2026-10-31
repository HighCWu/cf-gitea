/**
 * The composer p2 route REGRESSION suite — the packages-minor probes
 * battery's find (2026-10-31): the two literal-tail routes
 * (`:project~dev.json` / `:project.json`) captured under Hono's folded
 * LABEL ("project~dev.json"), so `param("project")` was undefined and
 * EVERY p2 document 404'd (upstream chi separates the dot via its
 * [^/^.]+ class — api.go:141's p2 mounts). The fix: ONE whole-segment
 * `:filename` route + handler-side suffix dispatch (the ~dev twin strips,
 * a non-.json segment answers the family's own 404 body). This suite
 * drives the ROUTE face — the six-minor families' service tests never
 * touched it, which is exactly how the bug shipped.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { createEcosystemProtocolRouter } from "./packages-protocols";
import { users } from "../../db/schema";
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
});

// The stored-entry zip builder (the composer service suite's own shape).
const encoder = new TextEncoder();
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}
function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}
function makeZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const crc = crc32(e.data);
    parts.push(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(e.data.byteLength), u32(e.data.byteLength), u16(nameBytes.byteLength), u16(0), nameBytes, e.data);
    central.push(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(e.data.byteLength), u32(e.data.byteLength), u16(nameBytes.byteLength), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes);
    offset += 30 + nameBytes.byteLength + e.data.byteLength;
  }
  const body = concat(parts);
  const dir = concat(central);
  const end = concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(dir.byteLength), u32(body.byteLength), u16(0)]);
  return concat([body, dir, end]);
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function composerArchive(name: string, version: string): Uint8Array {
  return makeZip([
    { name: "composer.json", data: encoder.encode(JSON.stringify({ name, version, description: "route regression" })) },
    { name: "README.md", data: encoder.encode("# r") },
  ]);
}

/** The REAL mount shape (the swift suite's): the sub-app at /api/packages. */
function fetcher(): (path: string, init?: RequestInit) => Promise<Response> {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createEcosystemProtocolRouter());
  return async (path, init) => await parent.fetch(new Request(`https://example.com${path}`, init), env);
}

/** Seed an owner + PAT, PUBLISH via the real PUT wire, return the fetcher + auth. */
async function seedApp(name: string): Promise<{ get: (path: string, token: string) => Promise<Response>; owner: string; token: string }> {
  const row = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "cowner", usernameLower: "cowner", type: "user", status: "active", createdAt: new Date(0) })
      .returning({ id: users.id, username: users.username })
      .all()
  )[0];
  if (row === undefined) throw new Error("owner seed failed");
  const { plaintext: token } = await mintFor(row.id, "composer-route-test");
  const get = fetcher();
  const put = await get(`/api/packages/${row.username}/composer?version=1.0.0`, {
    method: "PUT",
    headers: { authorization: `token ${token}`, "content-type": "application/octet-stream" },
    body: composerArchive(name, "1.0.0"),
  });
  expect(put.status).toBe(201);
  return {
    get: (path, tok) => get(path, { headers: { authorization: `Bearer ${tok}` } }),
    owner: row.username,
    token,
  };
}

describe("the composer p2 metadata ROUTE (the folded-label regression)", () => {
  it("serves the PLAIN p2 document (the pre-fix 404-for-every-project arm)", async () => {
    const { get, owner, token } = await seedApp("c/pkg-a");
    const res = await get(`/api/packages/${owner}/composer/p2/c/pkg-a.json`, token);
    expect(res.status).toBe(200);
    const doc: Record<string, unknown> = await res.json();
    expect(Object.keys(doc)).toContain("packages");
  });

  it("serves the ~dev twin (the suffix strips, same document)", async () => {
    const { get, owner, token } = await seedApp("c/pkg-dev");
    const res = await get(`/api/packages/${owner}/composer/p2/c/pkg-dev~dev.json`, token);
    expect(res.status).toBe(200);
    const doc: Record<string, unknown> = await res.json();
    expect(Object.keys(doc)).toContain("packages");
  });

  it("answers the family 404 body for a non-.json segment (chi's class never matched these)", async () => {
    const { get, owner, token } = await seedApp("c/pkg-x");
    const res = await get(`/api/packages/${owner}/composer/p2/c/notjson`, token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ errors: [{ status: 404, message: "package does not exist" }] });
  });
});
