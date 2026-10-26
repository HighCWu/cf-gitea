/**
 * The public avatar serving seam (src/web/avatar-serving.ts) on real D1 + R2
 * — the surveyed web family `GET /avatar/*`, `/user/avatar/*`
 * (docs/compat/ui-parity-survey.md:160) plus its `/avatars/*` storage
 * backend, with the write half (the landed API batch, api/routes/
 * avatars.test.ts) supplying the stored bytes through services/avatars.ts.
 *
 * The brief's red→green spine, per arm:
 *   - store avatar (uploadAvatar) → serve by owner id (/avatars/u_<id>);
 *   - serve by email hash (/avatar/<HashEmail>) → the frozen-settings
 *     default-link redirect (private, max-age=300; 303);
 *   - unknown-hash fallback → the deterministic 96px identicon arm verbatim
 *     (image/png, generic ETag public cache, 304 on If-None-Match);
 *   - plus the /user/avatar/{username}/{size} chain (custom-avatar link,
 *     the GenerateRandomAvatar auto-generate arm, the 500 miss) and the
 *     identicon/PNG port's determinism contract.
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import { renderIdenticonPng, IDENTICON_DARK_COLORS } from "../services/avatar-identicon";
import { hashAvatar, hashEmail, uploadAvatar } from "../services/avatars";
import { avatarServingRouter, cleanAvatarPath } from "./avatar-serving";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users").run();
  // The avatars/ prefix of the shared bucket — the whole serving key space.
  let cursor: string | undefined;
  do {
    const page = await env.REPO_PACKS.list({ prefix: "avatars/", cursor });
    for (const object of page.objects) {
      await env.REPO_PACKS.delete(object.key);
    }
    cursor = page.truncated === true ? page.cursor : undefined;
  } while (cursor !== undefined);
});

const db = () => drizzle(env.DB);

/** GET/HEAD against the bare serving router (anonymous, like upstream). */
const serve = async (path: string, init?: RequestInit): Promise<Response> =>
  avatarServingRouter.request(path, init, env);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pngBytes(width: number, height: number, pad = 0): Uint8Array {
  const bytes = new Uint8Array(33 + pad);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function seedUser(username: string, email: string | null): Promise<{ id: number; username: string; email: string | null }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      email,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, email };
}

function pngHeader(bytes: ArrayBuffer): { width: number; height: number; depth: number; colorType: number } {
  const view = new DataView(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20), depth: view.getUint8(24), colorType: view.getUint8(25) };
}

// ---------------------------------------------------------------------------
// GET, HEAD /avatars/* — the avatarStorageHandler port
// ---------------------------------------------------------------------------

describe("GET, HEAD /avatars/* (avatarStorageHandler port)", () => {
  it("serves a stored user avatar by the owner-id key with public-static caching", async () => {
    const user = await seedUser("alice", "alice@example.com");
    const data = pngBytes(64, 64);
    await uploadAvatar({
      bucket: env.REPO_PACKS,
      d1: env.DB,
      target: { kind: "user", principalId: user.id },
      data,
      contentType: "image/png",
    });
    const res = await serve(`/avatars/u_${user.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=21600");
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect(res.headers.get("content-length")).toBe(String(data.length));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(data));
  });

  it("streams a repo avatar under its storage key", async () => {
    const data = pngBytes(16, 16);
    await uploadAvatar({
      bucket: env.REPO_PACKS,
      d1: env.DB,
      target: { kind: "repo", storageKey: "r_avatar-test" },
      data,
      contentType: "image/png",
    });
    const res = await serve("/avatars/r_avatar-test");
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(data.length);
  });

  it("answers HEAD with the same headers and no body", async () => {
    const user = await seedUser("carol", null);
    await uploadAvatar({
      bucket: env.REPO_PACKS,
      d1: env.DB,
      target: { kind: "user", principalId: user.id },
      data: pngBytes(8, 8),
      contentType: "image/png",
    });
    const res = await serve(`/avatars/u_${user.id}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=21600");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("304s If-Modified-Since at second precision and serves a stale client", async () => {
    const user = await seedUser("dave", null);
    await uploadAvatar({
      bucket: env.REPO_PACKS,
      d1: env.DB,
      target: { kind: "user", principalId: user.id },
      data: pngBytes(8, 8),
      contentType: "image/png",
    });
    const stored = await env.REPO_PACKS.head(`avatars/u_${user.id}`);
    expect(stored).not.toBeNull();
    const modified = new Date(Math.floor((stored as { uploaded: Date }).uploaded.getTime() / 1000) * 1000);
    const fresh = await serve(`/avatars/u_${user.id}`, { headers: { "If-Modified-Since": modified.toUTCString() } });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("cache-control")).toBe("public, max-age=21600");
    const stale = await serve(`/avatars/u_${user.id}`, {
      headers: { "If-Modified-Since": "Mon, 01 Jan 1990 00:00:00 GMT" },
    });
    expect(stale.status).toBe(200);
  });

  it("falls back to a deterministic 96px indexed identicon for unknown paths", async () => {
    const first = await serve("/avatars/deadbeef-not-stored");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("cache-control")).toBe("public, max-age=21600");
    expect(first.headers.get("etag")).toBe('"avatar-cf-gitea-1"');
    const header = pngHeader(await first.arrayBuffer());
    expect(header).toEqual({ width: 96, height: 96, depth: 8, colorType: 3 });
    // Deterministic per path — the seeded generator, byte-stable within a run.
    const second = await serve("/avatars/deadbeef-not-stored");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array(await (await serve("/avatars/deadbeef-not-stored")).arrayBuffer()));
    // A different path renders different pixels.
    const other = await serve("/avatars/some-other-path");
    expect(new Uint8Array(await other.arrayBuffer())).not.toEqual(new Uint8Array(await (await serve("/avatars/deadbeef-not-stored")).arrayBuffer()));
  });

  it("304s the fallback on If-None-Match and mirrors HEAD's bodyless form", async () => {
    const etag = '"avatar-cf-gitea-1"';
    const matched = await serve("/avatars/unknown-path", { headers: { "If-None-Match": etag } });
    expect(matched.status).toBe(304);
    const weak = await serve("/avatars/unknown-path", { headers: { "If-None-Match": `W/${etag}` } });
    expect(weak.status).toBe(304);
    const wildcard = await serve("/avatars/unknown-path", { headers: { "If-None-Match": "*" } });
    expect(wildcard.status).toBe(304);
    const head = await serve("/avatars/unknown-path", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("404s the empty and fully-cleaned path arms", async () => {
    // NOTE: dot segments (literal or percent-encoded) never reach the handler
    // on Workers — workerd's URL parser folds them while building the
    // Request (Go's net/http keeps them raw in r.URL.Path, where the
    // PathJoinRelX port answers "not found"). Encoded dots therefore land in
    // Hono's default 404 with the same status and a platform body.
    const exact = await serve("/avatars/");
    expect(exact.status).toBe(404);
    expect(await exact.text()).toBe("not found\n");
    for (const path of ["/avatars/%2e", "/avatars/%2e%2e", "/avatars/x/%2e%2e/%2e%2e"]) {
      const res = await serve(path);
      expect(res.status, path).toBe(404);
    }
  });

  it("cleans traversal segments like util.PathJoinRelX", async () => {
    const user = await seedUser("erin", null);
    const data = pngBytes(8, 8);
    await uploadAvatar({
      bucket: env.REPO_PACKS,
      d1: env.DB,
      target: { kind: "user", principalId: user.id },
      data,
      contentType: "image/png",
    });
    expect((await serve(`/avatars/./u_${user.id}`)).status).toBe(200); // parser-folded, prefix intact
    expect((await serve(`/avatars/garbage/%2e%2e/u_${user.id}`)).status).toBe(200); // decoded, then cleaned
  });
});

// ---------------------------------------------------------------------------
// GET /avatar/{hash} — the AvatarByEmailHash port
// ---------------------------------------------------------------------------

describe("GET /avatar/{hash} (AvatarByEmailHash port)", () => {
  it("redirects a real email hash to the frozen-settings default link", async () => {
    const hash = await hashEmail("frank@example.com");
    expect(hash).toHaveLength(64); // EncodeSha256 hex
    const res = await serve(`/avatar/${hash}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/assets/img/avatar_default.png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(`<a href="/assets/img/avatar_default.png">See Other</a>.\n\n`);
  });

  it("answers an unknown hash identically (the !has arm converges on the same link)", async () => {
    const res = await serve("/avatar/0000000000000000000000000000000000000000000000000000000000000000");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/assets/img/avatar_default.png");
  });

  it("keeps the ?size form param in the chain (unused at the frozen settings)", async () => {
    const res = await serve("/avatar/abc?size=64");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/assets/img/avatar_default.png");
  });

  it("HEAD stays bodyless", async () => {
    const res = await serve("/avatar/abc", { method: "HEAD" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/assets/img/avatar_default.png");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /user/avatar/{username}/{size} — the AvatarByUsernameSize port
// ---------------------------------------------------------------------------

describe("GET /user/avatar/{username}/{size} (AvatarByUsernameSize port)", () => {
  it("links a custom-avatar user to the owner-id object (size query on positive sizes)", async () => {
    const user = await seedUser("grace", null);
    await uploadAvatar({
      bucket: env.REPO_PACKS,
      d1: env.DB,
      target: { kind: "user", principalId: user.id },
      data: pngBytes(16, 16),
      contentType: "image/png",
    });
    const sized = await serve(`/user/avatar/grace/64`);
    expect(sized.status).toBe(303);
    expect(sized.headers.get("location")).toBe(`/avatars/u_${user.id}?size=64`);
    expect(sized.headers.get("cache-control")).toBe("private, max-age=300");
    const unsized = await serve(`/user/avatar/grace/0`);
    expect(unsized.headers.get("location")).toBe(`/avatars/u_${user.id}`);
  });

  it("auto-generates and stores the seeded random avatar for a plain user (DisableGravatar arm)", async () => {
    const user = await seedUser("henry", "henry@example.com");
    const expectedFile = await hashAvatar(user.id, "henry@example.com");
    const res = await serve(`/user/avatar/henry/0`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/avatars/${expectedFile}`);
    // GenerateRandomAvatar's store-if-absent: the object now exists, 512px.
    const stored = await env.REPO_PACKS.head(`avatars/${expectedFile}`);
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
    const generated = await env.REPO_PACKS.get(`avatars/${expectedFile}`);
    const header = pngHeader((await generated?.arrayBuffer()) as ArrayBuffer);
    expect(header).toEqual({ width: 512, height: 512, depth: 8, colorType: 3 });
    // The second request recomputes the same name and reuses the object.
    const again = await serve(`/user/avatar/henry/0`);
    expect(again.headers.get("location")).toBe(`/avatars/${expectedFile}`);
    const keys = (await env.REPO_PACKS.list({ prefix: "avatars/" })).objects;
    expect(keys).toHaveLength(1);
  });

  it("looks users up case-insensitively (lower_name)", async () => {
    const user = await seedUser("iris", null);
    const res = await serve(`/user/avatar/IRIS/0`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/avatars/${await hashAvatar(user.id, "iris")}`);
  });

  it("500s an unknown username (upstream's GetUserByName ServerError arm)", async () => {
    const res = await serve("/user/avatar/ghost/0");
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The identicon port (services/avatar-identicon) — determinism contract
// ---------------------------------------------------------------------------

describe("identicon port (modules/avatar/identicon)", () => {
  const seed = new TextEncoder().encode("identicon-seed");

  it("is byte-deterministic per seed and size", async () => {
    const first = await renderIdenticonPng(96, seed);
    const second = await renderIdenticonPng(96, seed);
    expect(Array.from(first.bytes)).toEqual(Array.from(second.bytes));
  });

  it("renders different seeds to different streams", async () => {
    const other = await renderIdenticonPng(96, new TextEncoder().encode("another-seed"));
    expect(Array.from(other.bytes)).not.toEqual(Array.from((await renderIdenticonPng(96, seed)).bytes));
  });

  it("clamps size into New()'s [16, 2048] bounds", async () => {
    expect((await renderIdenticonPng(8, seed)).size).toBe(16);
    expect((await renderIdenticonPng(9999, seed)).size).toBe(2048);
  });

  it("carries the 124-entry DarkColors palette and a valid indexed-PNG frame", async () => {
    expect(IDENTICON_DARK_COLORS).toHaveLength(124); // colors.go, verified by count
    const png = await renderIdenticonPng(32, seed);
    const view = new DataView(png.bytes.buffer);
    // PNG signature + IHDR (13-byte payload, indexed color type).
    expect(Array.from(png.bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(view.getUint32(8)).toBe(13);
    expect(Array.from(png.bytes.subarray(12, 16))).toEqual([0x49, 0x48, 0x44, 0x52]);
    expect(view.getUint32(16)).toBe(32);
    expect(view.getUint32(20)).toBe(32);
    expect(view.getUint8(24)).toBe(8); // bit depth
    expect(view.getUint8(25)).toBe(3); // color type: indexed
    // The chunk walk terminates on IEND with zero-length payload.
    let at = 8;
    for (;;) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...png.bytes.subarray(at + 4, at + 8));
      if (type === "IEND") {
        expect(length).toBe(0);
        expect(at + 12).toBe(png.bytes.length);
        break;
      }
      at += 12 + length;
      expect(at).toBeLessThan(png.bytes.length);
    }
  });
});

// ---------------------------------------------------------------------------
// cleanAvatarPath — the util.PathJoinRelX port
// ---------------------------------------------------------------------------

describe("cleanAvatarPath (util.PathJoinRelX)", () => {
  it("resolves dots and clamps root-level ..", () => {
    expect(cleanAvatarPath("a/../b")).toBe("b");
    expect(cleanAvatarPath("a/./b")).toBe("a/b");
    expect(cleanAvatarPath("..")).toBe("");
    expect(cleanAvatarPath("a/../..")).toBe("");
    expect(cleanAvatarPath(".")).toBe("");
    expect(cleanAvatarPath("")).toBe("");
  });

  it("normalizes backslashes and stray slashes", () => {
    expect(cleanAvatarPath("a\\b")).toBe("a/b");
    expect(cleanAvatarPath("//a//b//")).toBe("a/b");
  });
});
