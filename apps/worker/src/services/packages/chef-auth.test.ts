/**
 * The Chef X-Ops signed-header authentication battery (SPEC-0016 — the
 * chef.Auth port) on real D1 — upstream routers/api/packages/chef/auth.go
 * at the pin, the SIGNATURE CONSTRUCTION lifted from upstream's own
 * integration test (tests/integration/api_packages_chef_test.go's
 * signRequest — the canonical strings, the sha1-b64 username/path arms,
 * the 60-char X-Ops-Authorization-N chunking, the raw-RSA old-version
 * signing) so every round-trip proves the wire contract, not our own
 * inverse:
 *
 *  - the `chef.public_pem` store arm (user_settings_kv) + the keypair
 *    generator (PKCS#1 private / SPKI public, the KeyBits=4096 default);
 *  - the applicability probe (no X-Ops-Userid → not applicable), the
 *    user lookup, the no-key user, the non-RSA key;
 *  - the ±10 min timestamp window and the RFC3339 shape;
 *  - the X-Ops-Sign version {1.0,1.1,1.2,1.3} + algorithm gates;
 *  - the X-Ops-Authorization-N chunk join (gap + garbage arms);
 *  - SIGN/VERIFY round-trips for ALL FOUR versions (1.0/1.1 raw RSA via
 *    the private d, 1.2/1.3 RSASSA-PKCS1-v1_5 via WebCrypto);
 *  - the route-face acceptance order: Basic wins, X-Ops fires when the
 *    standard pass yields nothing, a failed attempt is the byte-exact
 *    401 "Failed to authenticate user" Go http.Error body, anonymous
 *    reads stay open on a public owner.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { users, userSettingsKv } from "../../db/schema";
import { bytesToBase64, buildTar, gzipCompress, type TarEntry } from "./distro-common";
import {
  CHEF_PUBLIC_PEM_SETTING,
  ChefAuthError,
  authenticateChefXOps,
  buildChefCheckData,
  generateChefKeyPair,
  getChefAuthorizationSignature,
  getChefPublicPem,
  getChefSignVersion,
  parseChefPublicKey,
  pathClean,
  setChefPublicPem,
  verifyChefTimestamp,
  verifyChefXOpsRequest,
} from "./chef-auth";
import { createEcosystemProtocolRouter } from "../../api/routes/packages-protocols";
import { basicTokenHeader, mintFor } from "../../auth/testing/seeds";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["user_settings_kv", "package_files", "package_blobs", "package_versions", "packages", "personal_access_tokens", "auth_failures", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const prefix of ["packages/tmp/", "packages/blobs/"]) {
    const listed = await env.REPO_PACKS.list({ prefix });
    await env.REPO_PACKS.delete(listed.objects.map((object) => object.key));
  }
});

const db = () => drizzle(env.DB);

async function seedUser(username: string): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: "user",
      visibility: "public",
      createdAt: new Date("2026-10-31T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username };
}

// ---------------------------------------------------------------------------
// The upstream test's signing walk (api_packages_chef_test.go signRequest)
// ---------------------------------------------------------------------------

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function bigIntToBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0);
  const hex = value.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function modExp(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  let acc = base % modulus;
  let exp = exponent;
  while (exp > 0n) {
    if (exp & 1n) result = (result * acc) % modulus;
    acc = (acc * acc) % modulus;
    exp >>= 1n;
  }
  return result;
}

async function sha1Base64(text: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text))));
}

interface SignedRequestSpec {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/**
 * api_packages_chef_test.go:171-251 verbatim walk — the canonical string
 * per version, the raw-RSA (1.0/1.1) or RSASSA-PKCS1-v1_5 (1.2/1.3)
 * signature, the 60-char chunk split across X-Ops-Authorization-N.
 */
async function signXOps(spec: SignedRequestSpec, version: string, priv: JsonWebKey): Promise<Record<string, string>> {
  let username = spec.headers["x-ops-userid"] ?? "";
  if (version !== "1.0" && version !== "1.3") {
    username = await sha1Base64(username);
  }
  const sign = `version=${version}`;
  let data: Uint8Array;
  if (version === "1.3") {
    data = new TextEncoder().encode(
      [
        `Method:${spec.method}`,
        `Path:${spec.path}`,
        `X-Ops-Content-Hash:${spec.headers["x-ops-content-hash"] ?? ""}`,
        `X-Ops-Sign:version=${version}`,
        `X-Ops-Timestamp:${spec.headers["x-ops-timestamp"] ?? ""}`,
        `X-Ops-UserId:${username}`,
        `X-Ops-Server-API-Version:${spec.headers["x-ops-server-api-version"] ?? ""}`,
      ].join("\n"),
    );
  } else {
    const hashedPath = await sha1Base64(spec.path);
    data = new TextEncoder().encode(
      [
        `Method:${spec.method}`,
        `Hashed Path:${hashedPath}`,
        `X-Ops-Content-Hash:${spec.headers["x-ops-content-hash"] ?? ""}`,
        `X-Ops-Timestamp:${spec.headers["x-ops-timestamp"] ?? ""}`,
        `X-Ops-UserId:${username}`,
      ].join("\n"),
    );
  }
  let signature: Uint8Array;
  if (version === "1.3" || version === "1.2") {
    const hash = version === "1.3" ? "SHA-256" : "SHA-1";
    // The generated JWK pins alg "RS256" (the SHA-256 keygen bind); the
    // import must NOT carry it when verifying/signing under SHA-1 — a bare
    // CRT-field JWK lets the requested algorithm speak.
    const bare: JsonWebKey = {
      kty: priv.kty,
      n: priv.n,
      e: priv.e,
      d: priv.d,
      p: priv.p,
      q: priv.q,
      dp: priv.dp,
      dq: priv.dq,
      qi: priv.qi,
    };
    const key = await crypto.subtle.importKey("jwk", bare, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["sign"]);
    signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data));
  } else {
    // verifyDataOld's inverse — raw RSA with the PRIVATE exponent (d and n
    // ride the JWK as base64url).
    const d = priv.d;
    const n = priv.n;
    if (typeof d !== "string" || typeof n !== "string") throw new Error("private JWK incomplete");
    signature = bigIntToBytes(modExp(bytesToBigInt(data), bytesToBigInt(base64ToBigEndianBytes(d)), bytesToBigInt(base64ToBigEndianBytes(n))));
  }
  const enc = bytesToBase64(signature);
  const out: Record<string, string> = { ...spec.headers, "x-ops-sign": sign };
  const chunkSize = 60;
  let currentLen = 0;
  let currentStart = 0;
  const chunks: string[] = [];
  for (let i = 0; i < enc.length; i++) {
    if (currentLen === chunkSize) {
      chunks.push(enc.slice(currentStart, i));
      currentLen = 0;
      currentStart = i;
    }
    currentLen++;
  }
  chunks.push(enc.slice(currentStart));
  chunks.forEach((chunk, index) => {
    out[`x-ops-authorization-${index + 1}`] = chunk;
  });
  return out;
}

function base64ToBigEndianBytes(base64Url: string): Uint8Array {
  const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function headersObject(entries: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(entries)) headers.set(name, value);
  return headers;
}

async function verifyOrFail(spec: {
  method: string;
  path: string;
  headers: Record<string, string>;
  publicPem: string;
  now?: Date;
}): Promise<void> {
  const key = await parseChefPublicKey(spec.publicPem);
  await verifyChefXOpsRequest(
    {
      headers: headersObject(spec.headers),
      method: spec.method,
      urlPath: spec.path,
      now: spec.now ?? new Date(),
    },
    key,
  );
}

const encoder = new TextEncoder();
const METADATA_JSON = JSON.stringify({
  name: "test",
  version: "1.0.1",
  description: "Test Description",
  maintainer: "KN4CK3R",
});

async function makeCookbook(): Promise<Uint8Array> {
  const entries: TarEntry[] = [{ name: "test/metadata.json", mode: 0o600, data: encoder.encode(METADATA_JSON) }];
  return gzipCompress(buildTar(entries, true));
}

describe("chef-auth store arm", () => {
  it("round-trips chef.public_pem through user_settings_kv", async () => {
    const user = await seedUser("chef-store");
    expect(await getChefPublicPem(env.DB, user.id)).toBeNull();
    await setChefPublicPem(env.DB, user.id, "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----\n");
    expect(await getChefPublicPem(env.DB, user.id)).toBe("-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----\n");
    await setChefPublicPem(env.DB, user.id, "-----BEGIN PUBLIC KEY-----\nBBB\n-----END PUBLIC KEY-----\n");
    expect(await getChefPublicPem(env.DB, user.id)).toBe("-----BEGIN PUBLIC KEY-----\nBBB\n-----END PUBLIC KEY-----\n");
    const stored = await db()
      .select({ key: userSettingsKv.settingKey })
      .from(userSettingsKv)
      .all();
    expect(stored.map((row) => row.key)).toEqual([CHEF_PUBLIC_PEM_SETTING]);
  });

  it("generates the upstream keypair shape — PKCS#1 private, SPKI public, usable pair", async () => {
    const pair = await generateChefKeyPair(2048);
    expect(pair.privatePem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(pair.privatePem.endsWith("\n-----END RSA PRIVATE KEY-----\n")).toBe(true);
    expect(pair.publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(pair.publicPem.endsWith("\n-----END PUBLIC KEY-----\n")).toBe(true);
    // The private PEM's DER decodes (a well-formed PKCS#1 block — the DER
    // walk lives in the unwrap that produced it; this pins the emitted
    // base64 body back to bytes).
    const pemBody = pair.privatePem
      .replace("-----BEGIN RSA PRIVATE KEY-----\n", "")
      .replace("\n-----END RSA PRIVATE KEY-----\n", "")
      .replace(/\n/g, "");
    expect(base64ToBigEndianBytes(pemBody).byteLength).toBeGreaterThan(0);
    // SPKI parse imports and yields the matching modulus + e = 65537.
    const key = await parseChefPublicKey(pair.publicPem);
    const n = pair.privateJwk.n;
    if (typeof n !== "string") throw new Error("private JWK incomplete");
    expect(key.modulus).toBe(bytesToBigInt(base64ToBigEndianBytes(n)));
    expect(key.exponent).toBe(65537n);
    // The default ride: KeyBits=4096 (metadata.go:20) — slow keygen once.
    const full = await generateChefKeyPair();
    expect(await parseChefPublicKey(full.publicPem)).toMatchObject({ exponent: 65537n });
  });
});

describe("chef-auth verify walk", () => {
  let user: { id: number; username: string };
  let pair: Awaited<ReturnType<typeof generateChefKeyPair>>;
  const now = new Date("2026-10-31T12:00:00Z");
  const ts = "2026-10-31T12:00:00Z";

  beforeEach(async () => {
    user = await seedUser("chef-auth");
    pair = await generateChefKeyPair(2048);
    await setChefPublicPem(env.DB, user.id, pair.publicPem);
  });

  const spec = (headers: Record<string, string>): SignedRequestSpec => ({
    method: "POST",
    path: "/api/packages/chef-auth/chef/api/v1/cookbooks",
    headers,
  });

  it("is not applicable without X-Ops-Userid (auth.go:63-65 nilnil)", async () => {
    const result = await authenticateChefXOps(env.DB, new Request("https://x.test/api/packages/a/chef/api/v1/universe"));
    expect(result.user).toBeNull();
    expect(result.error).toBeNull();
  });

  it("fails on a not-existing user", async () => {
    const result = await authenticateChefXOps(
      env.DB,
      new Request("https://x.test/api/packages/a/chef/api/v1/universe", {
        headers: { "x-ops-userid": "ghost-user" },
      }),
      now,
    );
    expect(result.user).toBeNull();
    expect(result.error).toBeInstanceOf(ChefAuthError);
  });

  it("resolves the user case-insensitively (GetUserByName's lower_name walk)", async () => {
    // The UPPERCASE userid rides the signed headers themselves (a mixed-case
    // dict literal would construct JOINED duplicate headers — clients send
    // one X-Ops-Userid and Go's Header.Get reads the first).
    const signed = await signXOps(
      spec({ "x-ops-userid": user.username.toUpperCase(), "x-ops-timestamp": ts, "x-ops-content-hash": "unused" }),
      "1.3",
      pair.privateJwk,
    );
    const result = await authenticateChefXOps(
      env.DB,
      new Request("https://x.test/api/packages/chef-auth/chef/api/v1/cookbooks", {
        method: "POST",
        headers: signed,
      }),
      now,
    );
    expect(result.error).toBeNull();
    expect(result.user?.id).toBe(user.id);
  });

  it("fails on a user with no stored key (the read precedes the timestamp arm)", async () => {
    const nobody = await seedUser("chef-nokey");
    const result = await authenticateChefXOps(
      env.DB,
      new Request("https://x.test/api/packages/a/chef/api/v1/universe", {
        headers: { "x-ops-userid": nobody.username },
      }),
      now,
    );
    expect(result.user).toBeNull();
    expect(result.error).toBeInstanceOf(ChefAuthError);
  });

  it("rejects a non-RSA stored key", async () => {
    const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    if (!("publicKey" in ec)) throw new Error("EC keygen did not return a pair");
    const spki = await crypto.subtle.exportKey("spki", ec.publicKey);
    if (!(spki instanceof ArrayBuffer)) throw new Error("unexpected EC export form");
    await setChefPublicPem(
      env.DB,
      user.id,
      `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(new Uint8Array(spki))}\n-----END PUBLIC KEY-----\n`,
    );
    const result = await authenticateChefXOps(
      env.DB,
      new Request("https://x.test/api/packages/a/chef/api/v1/universe", {
        headers: { "x-ops-userid": user.username },
      }),
      now,
    );
    expect(result.error?.message).toBe("public key is not a RSA key");
  });

  it("rejects a garbage stored PEM", async () => {
    await setChefPublicPem(env.DB, user.id, "not a pem at all");
    const result = await authenticateChefXOps(
      env.DB,
      new Request("https://x.test/api/packages/a/chef/api/v1/universe", {
        headers: { "x-ops-userid": user.username },
      }),
      now,
    );
    expect(result.error).toBeInstanceOf(ChefAuthError);
  });

  describe("timestamp window (auth.go:113-134)", () => {
    it("requires the header", () => {
      expect(() => verifyChefTimestamp(null, now)).toThrow(ChefAuthError);
      expect(() => verifyChefTimestamp("", now)).toThrow(ChefAuthError);
    });

    it("requires the RFC3339 shape", () => {
      expect(() => verifyChefTimestamp("2026-10-31 12:00:00Z", now)).toThrow(ChefAuthError);
      expect(() => verifyChefTimestamp("2026-10-31T12:00:00", now)).toThrow(ChefAuthError);
      expect(() => verifyChefTimestamp("not-a-time", now)).toThrow(ChefAuthError);
    });

    it("rejects beyond the ±10 min window both ways", () => {
      expect(() => verifyChefTimestamp("2026-10-31T11:49:59Z", now)).toThrow(/time difference/);
      expect(() => verifyChefTimestamp("2026-10-31T12:10:01Z", now)).toThrow(/time difference/);
    });

    it("accepts the window edge and fractional seconds", () => {
      expect(() => verifyChefTimestamp("2026-10-31T11:50:00Z", now)).not.toThrow();
      expect(() => verifyChefTimestamp("2026-10-31T12:10:00Z", now)).not.toThrow();
      expect(() => verifyChefTimestamp("2026-10-31T12:00:00.123456Z", now)).not.toThrow();
    });
  });

  describe("sign version gates (auth.go:136-161)", () => {
    it("requires the header", () => {
      expect(() => getChefSignVersion(null)).toThrow(/X-Ops-Sign header missing/);
      expect(() => getChefSignVersion("")).toThrow(/X-Ops-Sign header missing/);
    });

    it("parses the version parameter", () => {
      expect(getChefSignVersion("version=1.2")).toBe("1.2");
      expect(getChefSignVersion("version=1.3;algorithm=sha256")).toBe("1.3");
    });

    it.each(["version=none", "version=1.4", "version=1", "algorithm=sha1"])("rejects %s", (sign) => {
      expect(() => getChefSignVersion(sign)).toThrow(ChefAuthError);
    });

    it("restricts the algorithm parameter", () => {
      expect(() => getChefSignVersion("version=1.0;algorithm=sha2")).toThrow(/unsupported algorithm/);
      expect(() => getChefSignVersion("version=1.0;algorithm=sha256")).toThrow(/unsupported algorithm/);
      expect(getChefSignVersion("version=1.0;algorithm=sha1")).toBe("1.0");
      expect(getChefSignVersion("version=1.2;algorithm=sha1")).toBe("1.2");
      expect(getChefSignVersion("version=1.3;algorithm=sha256")).toBe("1.3");
    });
  });

  describe("authorization chunk join (auth.go:181-205)", () => {
  it("joins index-ordered chunks", () => {
    const headers = headersObject({ "x-ops-authorization-2": "AA", "x-ops-authorization-1": "AA" });
    expect(bytesToBase64(getChefAuthorizationSignature(headers))).toBe("AAAA");
  });

    it("rejects a gap in the indexes", () => {
      const headers = headersObject({ "x-ops-authorization-1": "AA", "x-ops-authorization-3": "Kk=" });
      expect(() => getChefAuthorizationSignature(headers)).toThrow(/invalid X-Ops-Authorization headers/);
    });

    it("rejects a zero index and non-base64 chunks", () => {
      expect(() => getChefAuthorizationSignature(headersObject({ "x-ops-authorization-0": "AA" }))).toThrow(ChefAuthError);
      expect(() => getChefAuthorizationSignature(headersObject({ "x-ops-authorization-1": "!!!!" }))).toThrow(ChefAuthError);
      expect(() => getChefAuthorizationSignature(headersObject({ "x-ops-authorization-1": "AA" }))).toThrow(ChefAuthError);
    });
  });

  describe("pathClean (Go path.Clean)", () => {
    it.each([
      ["", "."],
      ["/", "/"],
      ["//", "/"],
      ["/a/b/c", "/a/b/c"],
      ["/a/b/../c", "/a/c"],
      ["/a/b/", "/a/b"],
      ["/a/./b", "/a/b"],
      ["a/b", "a/b"],
      ["../a", "../a"],
      ["/../a", "/a"],
      ["/a/../../b", "/b"],
      ["/api/packages/o/chef/api/v1/cookbooks", "/api/packages/o/chef/api/v1/cookbooks"],
    ])("cleans %j → %j", (input, expected) => {
      expect(pathClean(input)).toBe(expected);
    });
  });

  describe("sign/verify round-trips (the upstream test's signRequest)", () => {
    it.each(["1.0", "1.1", "1.2", "1.3"])("verifies version %s", async (version) => {
      const signed = await signXOps(
        spec({ "x-ops-userid": user.username, "x-ops-timestamp": ts, "x-ops-content-hash": "unused" }),
        version,
        pair.privateJwk,
      );
      await expect(verifyOrFail({ ...spec(signed), publicPem: pair.publicPem, now })).resolves.toBeUndefined();
    });

    it("verifies the 1.2 + sha1 / 1.3 + sha256 algorithm pairs end to end", async () => {
      const v12 = await signXOps(
        spec({ "x-ops-userid": user.username, "x-ops-timestamp": ts, "x-ops-content-hash": "unused" }),
        "1.2",
        pair.privateJwk,
      );
      v12["x-ops-sign"] = "version=1.2;algorithm=sha1";
      await expect(verifyOrFail({ ...spec(v12), publicPem: pair.publicPem, now })).resolves.toBeUndefined();
      const v13 = await signXOps(
        spec({ "x-ops-userid": user.username, "x-ops-timestamp": ts, "x-ops-content-hash": "unused" }),
        "1.3",
        pair.privateJwk,
      );
      v13["x-ops-sign"] = "version=1.3;algorithm=sha256";
      await expect(verifyOrFail({ ...spec(v13), publicPem: pair.publicPem, now })).resolves.toBeUndefined();
    });

    it("fails a tampered signature", async () => {
      const signed = await signXOps(
        spec({ "x-ops-userid": user.username, "x-ops-timestamp": ts, "x-ops-content-hash": "unused" }),
        "1.2",
        pair.privateJwk,
      );
      const chunk = signed["x-ops-authorization-1"];
      if (chunk === undefined) throw new Error("chunk missing");
      signed["x-ops-authorization-1"] = `${chunk.slice(0, -1)}${chunk.endsWith("A") ? "B" : "A"}`;
      await expect(verifyOrFail({ ...spec(signed), publicPem: pair.publicPem, now })).rejects.toBeInstanceOf(ChefAuthError);
    });

    it("fails a signature over a DIFFERENT path (the canonical string binds the request)", async () => {
      const signed = await signXOps(
        spec({ "x-ops-userid": user.username, "x-ops-timestamp": ts, "x-ops-content-hash": "unused" }),
        "1.1",
        pair.privateJwk,
      );
      await expect(
        verifyOrFail({
          method: "POST",
          path: "/api/packages/chef-auth/chef/api/v1/cookbooks/other",
          headers: signed,
          publicPem: pair.publicPem,
          now,
        }),
      ).rejects.toBeInstanceOf(ChefAuthError);
    });

    it("fails a stale signature inside an otherwise-valid request", async () => {
      const stale = await signXOps(
        spec({ "x-ops-userid": user.username, "x-ops-timestamp": "2026-10-31T11:00:00Z", "x-ops-content-hash": "unused" }),
        "1.3",
        pair.privateJwk,
      );
      await expect(verifyOrFail({ ...spec(stale), publicPem: pair.publicPem, now })).rejects.toThrow(/time difference/);
    });
  });

  it("builds the canonical check data byte-exactly (1.3 and the hashed-path shape)", async () => {
    const headers = headersObject({
      "x-ops-userid": "chef-auth",
      "x-ops-timestamp": ts,
      "x-ops-content-hash": "unused",
      "x-ops-server-api-version": "1.0",
    });
    const cleanPath = pathClean("/api/packages/chef-auth/chef/api/v1/cookbooks");
    const v13 = new TextDecoder().decode(await buildChefCheckData("1.3", "POST", cleanPath, headers));
    expect(v13).toBe(
      [
        "Method:POST",
        `Path:${cleanPath}`,
        "X-Ops-Content-Hash:unused",
        "X-Ops-Sign:version=1.3",
        `X-Ops-Timestamp:${ts}`,
        "X-Ops-UserId:chef-auth",
        "X-Ops-Server-API-Version:1.0",
      ].join("\n"),
    );
    const v10 = new TextDecoder().decode(await buildChefCheckData("1.0", "POST", cleanPath, headers));
    expect(v10).toBe(
      [
        "Method:POST",
        `Hashed Path:${await sha1Base64(cleanPath)}`,
        "X-Ops-Content-Hash:unused",
        `X-Ops-Timestamp:${ts}`,
        "X-Ops-UserId:chef-auth",
      ].join("\n"),
    );
    const v11 = new TextDecoder().decode(await buildChefCheckData("1.1", "POST", cleanPath, headers));
    expect(v11).toContain(`X-Ops-UserId:${await sha1Base64("chef-auth")}`);
  });
});

// ---------------------------------------------------------------------------
// The route-face acceptance order (api.go:96-102 + group.go:44-63)
// ---------------------------------------------------------------------------

describe("chef-auth route acceptance order", () => {
  let owner: { id: number; username: string };
  let pair: Awaited<ReturnType<typeof generateChefKeyPair>>;
  /** The REAL mount shape (the nuget battery's protocol() pattern): the
   *  sub-app under /api/packages, fetch given the workers env explicitly. */
  let protocolFetch: (path: string, init?: RequestInit) => Promise<Response>;
  const uploadPath = () => `/api/packages/${owner.username}/chef/api/v1/cookbooks`;

  const signedHeaders = async (version: string, overrides: Record<string, string> = {}): Promise<Record<string, string>> => {
    const spec: SignedRequestSpec = {
      method: "POST",
      path: uploadPath(),
      headers: {
        "x-ops-userid": owner.username,
        "x-ops-timestamp": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        "x-ops-content-hash": "unused",
        "content-type": "multipart/form-data; boundary=chefauthboundary",
        ...overrides,
      },
    };
    return signXOps(spec, version, pair.privateJwk);
  };

  const uploadRequest = async (headers: Record<string, string>): Promise<Response> => {
    const body = await makeCookbook();
    const multipart = `--chefauthboundary\r\ncontent-disposition: form-data; name="tarball"; filename="1.0.1.tar.gz"\r\ncontent-type: application/x-gzip\r\n\r\n`;
    const trailer = `\r\n--chefauthboundary--\r\n`;
    const payload = new Uint8Array([...encoder.encode(multipart), ...body, ...encoder.encode(trailer)]);
    return protocolFetch(uploadPath(), {
      method: "POST",
      headers,
      body: payload,
    });
  };

  beforeAll(() => {
    const parent = new Hono<{ Bindings: Env }>();
    parent.route("/api/packages", createEcosystemProtocolRouter());
    const boundEnv = { ...env };
    protocolFetch = async (path, init) => await parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
  });

  beforeEach(async () => {
    owner = await seedUser("chef-owner");
    pair = await generateChefKeyPair(2048);
    await setChefPublicPem(env.DB, owner.id, pair.publicPem);
  });

  it("accepts an upload signed with X-Ops alone (the reduction flip)", async () => {
    const response = await uploadRequest(await signedHeaders("1.2"));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({});
  });

  it.each(["1.0", "1.1", "1.3"])("accepts a version %s signed upload", async (version) => {
    expect((await uploadRequest(await signedHeaders(version))).status).toBe(201);
  });

  it("still accepts Basic credentials — the standard pass wins (api.go:97-98 order)", async () => {
    const token = (await mintFor(owner.id, "pat-chef", "all")).plaintext;
    const response = await uploadRequest({
      authorization: basicTokenHeader(token),
      "content-type": "multipart/form-data; boundary=chefauthboundary",
    });
    expect(response.status).toBe(201);
  });

  it("answers the byte-exact Go http.Error body on a BAD signature", async () => {
    const headers = await signedHeaders("1.2");
    // Tamper the SIGNATURE (the canonical string stays consistent — the
    // service must reject the verify, not the consistency).
    const chunk = headers["x-ops-authorization-1"];
    if (chunk === undefined) throw new Error("chunk missing");
    headers["x-ops-authorization-1"] = `${chunk.slice(0, -1)}${chunk.endsWith("A") ? "B" : "A"}`;
    const response = await uploadRequest(headers);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Failed to authenticate user\n");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("401s a stale timestamp on the wire", async () => {
    const headers = await signedHeaders("1.2", {
      "x-ops-timestamp": new Date(Date.now() - 11 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    const response = await uploadRequest(headers);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Failed to authenticate user\n");
  });

  it("401s a signed request from a user with NO stored key", async () => {
    const keyless = await seedUser("chef-keyless");
    const spec: SignedRequestSpec = {
      method: "POST",
      path: uploadPath(),
      headers: {
        "x-ops-userid": keyless.username,
        "x-ops-timestamp": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        "x-ops-content-hash": "unused",
        "content-type": "multipart/form-data; boundary=chefauthboundary",
      },
    };
    const response = await uploadRequest(await signXOps(spec, "1.2", pair.privateJwk));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Failed to authenticate user\n");
  });

  it("keeps anonymous reads open when the method is not applicable (public owner universe)", async () => {
    const response = await protocolFetch(`/api/packages/${owner.username}/chef/api/v1/universe`);
    expect(response.status).toBe(200);
  });

  it("keeps the anonymous upload challenge (the 401 + WWW-Authenticate gate)", async () => {
    const response = await uploadRequest({ "content-type": "multipart/form-data; boundary=chefauthboundary" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
  });
});
