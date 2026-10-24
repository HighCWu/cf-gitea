/**
 * LFS route family on the real bindings (SPEC-0006 §2.1-§2.3, §5): the full
 * worker path (gate branch → router → services) for the default RELY store
 * mode, plus a direct `serveLfs` pass for presign mode — both href modes of
 * the batch roundtrip. git-lfs client-shaped fixtures (Accept/Content-Type
 * media types, `transfers`/`ref` envelopes; relay upload hints carry no
 * Transfer-Encoding since 59a0776 — clients must send Content-Length)
 * and the upstream error tables throughout.
 */

import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { basicHeader, basicTokenHeader, mintFor, resetAuthTables, seedVerifiedUser } from "../auth/testing/seeds";
import { resolveRepository } from "../git-http/acl";
import { repositories, repoRedirects } from "../db/schema";
import {
  DEFAULT_LFS_LIMITS,
  LFS_ACCEPT_HEADER,
  LFS_MEDIA_TYPE,
} from "../services/lfs/batch";
import { LfsStateService } from "../services/lfs/state";
import {
  PresignLfsStore,
  RelayLfsStore,
  checksumHeaderFor,
  lfsKey,
  sha256Hex,
} from "../services/lfs/store";
import { applyLfsObjectsDdl, resetLfsTables } from "../services/lfs/testing";
import { defaultLfsDeps, handleLfsGateBranch, parseLfsRoute, serveLfs } from "./router";

const JSON_LD = "application/json";

beforeAll(async () => {
  // Applies the generated Drizzle migrations (0005 creates `lfs_objects`).
  await applyLfsObjectsDdl();
});

beforeEach(async () => {
  await resetAuthTables();
  await env.DB.prepare("DELETE FROM repositories").run();
  await env.DB.prepare("DELETE FROM repo_redirects").run();
  await resetLfsTables();
});

// R2 keys are uuid-scoped per test (lfs/r_<uuid>/<oid>), so leftovers from one
// test can never collide with another and no sweep is needed.

// --- fixtures -----------------------------------------------------------------

interface SeededRepo {
  id: string;
  storageKey: string;
  owner: string;
  slug: string;
}

async function seedRepo(
  ownerNamespace: string,
  slug: string,
  visibility: "public" | "private",
  options: { isArchived?: boolean } = {},
): Promise<SeededRepo> {
  const id = crypto.randomUUID();
  const storageKey = `r_${id}`;
  await drizzle(env.DB)
    .insert(repositories)
    .values({
      id,
      storageKey,
      ownerNamespace,
      slug,
      visibility,
      ...(options.isArchived === true ? { isArchived: true } : {}),
    })
    .run();
  return { id, storageKey, owner: ownerNamespace, slug };
}

interface Fixtures {
  alice: { id: number; username: string };
  write: string;
  read: string;
  wrongScope: string;
  publicOnly: string;
  publicRepo: SeededRepo;
  privateRepo: SeededRepo;
}

/** Fresh user/tokens/repos per test (rows are wiped in beforeEach). */
async function seedFixtures(): Promise<Fixtures> {
  const alice = await seedVerifiedUser({ username: "Alice" });
  const mint = async (name: string, scopes: string) => (await mintFor(alice.id, name, scopes)).plaintext;
  return {
    alice,
    write: await mint("lfs-write", "write:repository"),
    read: await mint("lfs-read", "read:repository"),
    wrongScope: await mint("lfs-wrong", "write:user"),
    publicOnly: await mint("lfs-public-only", "write:repository,public-only"),
    publicRepo: await seedRepo("alice", "public", "public"),
    privateRepo: await seedRepo("alice", "private", "private"),
  };
}

/** Deterministic per-test content with its REAL oid (the store enforces the
 *  sha256 binding; fixtures must be honest hashes). */
function content(ordinal: number, length = 128): Uint8Array {
  return new Uint8Array(length).fill(ordinal);
}

/** git-lfs batch request shape (modules/lfs/shared.go:27-32 + client headers). */
function lfsBatch(
  url: string,
  body: { operation: "upload" | "download"; objects: { oid: string; size: number }[] },
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(url, {
    method: "POST",
    headers: {
      accept: LFS_MEDIA_TYPE,
      "content-type": LFS_MEDIA_TYPE,
      ...headers,
    },
    body: JSON.stringify({ transfers: ["basic"], ref: { name: "refs/heads/main" }, ...body }),
  });
}

const repoUrl = (repo: SeededRepo): string => `https://example.com/${repo.owner}/${repo.slug}.git`;

async function lastRowState(repoId: number, oid: string): Promise<string | null> {
  const row = await new LfsStateService(env.DB).get(repoId, oid);
  return row?.state ?? null;
}

// --- route parsing ------------------------------------------------------------

describe("parseLfsRoute (SPEC-0006 §2.1 shapes)", () => {
  const base = "/alice/repo.git/info/lfs";

  it("parses the family with .git trimming and method dispatch", () => {
    expect(parseLfsRoute(`${base}/objects/batch`, "POST")).toMatchObject({ owner: "alice", repo: "repo", kind: "batch" });
    expect(parseLfsRoute("/alice/repo/info/lfs/objects/batch", "POST")).toMatchObject({ repo: "repo", kind: "batch" });
    expect(parseLfsRoute(`${base}/objects/${"a".repeat(64)}/128`, "PUT")).toMatchObject({
      kind: "upload",
      oid: "a".repeat(64),
      arg: "128",
    });
    expect(parseLfsRoute(`${base}/objects/${"a".repeat(64)}`, "GET")).toMatchObject({ kind: "download" });
    expect(parseLfsRoute(`${base}/objects/${"a".repeat(64)}/ZmlsZQ`, "GET")).toMatchObject({
      kind: "download",
      arg: "ZmlsZQ",
    });
    expect(parseLfsRoute(`${base}/verify`, "POST")).toMatchObject({ kind: "verify" });
    expect(parseLfsRoute(`${base}/locks`, "POST")).toMatchObject({ kind: "locks" });
    expect(parseLfsRoute(`${base}/locks/42/unlock`, "POST")).toMatchObject({ kind: "locks" });
  });

  it("catch-alls method mismatches, junk paths and bare /info/lfs", () => {
    expect(parseLfsRoute(`${base}/objects/batch`, "GET")?.kind).toBe("not-found");
    expect(parseLfsRoute(`${base}/verify`, "GET")?.kind).toBe("not-found");
    expect(parseLfsRoute(`${base}/objects/${"a".repeat(64)}`, "PUT")?.kind).toBe("not-found");
    expect(parseLfsRoute(`${base}/objects/${"a".repeat(64)}/1`, "POST")?.kind).toBe("not-found");
    expect(parseLfsRoute(`${base}`, "GET")?.kind).toBe("not-found");
    expect(parseLfsRoute(`${base}/whatever`, "GET")?.kind).toBe("not-found");
    expect(parseLfsRoute(`${base}/objects/a/b/c`, "GET")?.kind).toBe("not-found");
  });

  it("returns null outside the family (engine passthrough)", () => {
    expect(parseLfsRoute("/alice/repo.git/info/refs", "GET")).toBeNull();
    expect(parseLfsRoute("/alice/repo.git/git-upload-pack", "POST")).toBeNull();
    expect(parseLfsRoute("/alice", "GET")).toBeNull();
    expect(parseLfsRoute("/alice/repo.git/info/lfs%ZZ", "GET")).toBeNull();
  });
});

// --- auth & routing matrix ------------------------------------------------------

describe("LFS family auth (§2.2 split)", () => {
  it("404s a nonexistent repo before any auth challenge — engine passthrough, byte-identical", async () => {
    const response = await lfsBatch("https://example.com/nobody/nothing.git/info/lfs/objects/batch", {
      operation: "upload",
      objects: [],
    });

    // The D1-missing passthrough hands the ORIGINAL request to the engine —
    // its own 404 (plain text), no challenge, exactly the pre-LFS behavior.
    // The engine owns that shape (another wave's file); we only pin that the
    // LFS family did NOT answer it.
    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("content-type")).not.toContain("vnd.git-lfs");
  });

  it("challenges anonymous batch upload on a private repo with the gitea-lfs realm", async () => {
    const repo = await seedRepo("alice", "private", "private");
    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [],
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
    expect(response.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    expect(await response.json()).toEqual({ message: "Unauthorized" });
  });

  it("challenges a bad credential (identity not established)", async () => {
    const repo = await seedRepo("alice", "private", "private");
    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, { operation: "upload", objects: [] }, {
      authorization: basicHeader("alice", "cfg_00000000_DEADBEEF234567890123456789ABCDEFGHJKLMNP"),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
  });

  it("challenges (not 404) when the token grants no access — the LFS divergence", async () => {
    const bob = await seedVerifiedUser({ username: "Bob" });
    const bobWrite = (await mintFor(bob.id, "bob-write", "write:repository")).plaintext;
    const repo = await seedRepo("alice", "private", "private");

    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, { operation: "upload", objects: [] }, {
      authorization: basicTokenHeader(bobWrite),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
  });

  it("403s a token without the repository scope (upstream CheckRepoScopedToken)", async () => {
    const fixtures = await seedFixtures();
    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [],
    }, { authorization: basicTokenHeader(fixtures.wrongScope) });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.text()).toContain("Forbidden");
  });

  it("403s a read-scope token on the upload operation", async () => {
    const fixtures = await seedFixtures();
    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [],
    }, { authorization: basicTokenHeader(fixtures.read) });

    expect(response.status).toBe(403);
  });

  it("challenges a public-only token on a private repo (masked like git-HTTP, but 401)", async () => {
    const fixtures = await seedFixtures();
    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [],
    }, { authorization: basicTokenHeader(fixtures.publicOnly) });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
  });

  it("403s LFS writes on an archived repo (§4.11)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const write = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repo = await seedRepo("alice", "frozen", "private", { isArchived: true });

    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, { operation: "upload", objects: [] }, {
      authorization: basicTokenHeader(write),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("archived");
  });

  it("301s a renamed repo's old LFS URL before any auth challenge (row 13 pipeline)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "newname", "public");
    await drizzle(env.DB)
      .insert(repoRedirects)
      .values({ ownerId: alice.id, ownerNamespace: "alice", lowerName: "oldname", redirectRepoId: repo.id })
      .run();

    // redirect: "manual" — a following client would take the 301 to
    // /alice/newname.git/... and observe the catch-all 404 of the FOLLOWED
    // GET instead of the redirect itself.
    const response = await SELF.fetch("https://example.com/alice/oldname.git/info/lfs/objects/batch", {
      method: "POST",
      redirect: "manual",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE },
      body: JSON.stringify({ transfers: ["basic"], ref: { name: "refs/heads/main" }, operation: "upload", objects: [] }),
    });

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://example.com/alice/newname.git/info/lfs/objects/batch",
    );
  });
});

// --- gate branch passthrough (the e2e invariant) -----------------------------------

describe("handleLfsGateBranch passthrough for D1-missing repos", () => {
  it("hands the ORIGINAL request object to the engine untouched (byte-identical)", async () => {
    const request = new Request("https://example.com/demo/absent.git/info/lfs/objects/batch", {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE },
      body: JSON.stringify({ operation: "upload", objects: [] }),
    });
    const route = parseLfsRoute(new URL(request.url).pathname, "POST");
    if (route === null) throw new Error("route parse failed");

    const seen: Request[] = [];
    const engine = {
      fetch: (req: Request): Promise<Response> => {
        seen.push(req);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    };
    // The passthrough never touches ctx members (only forwards it to the
    // engine) — the repo's stub-ctx convention (cf. webhooks/dlq.test.ts).
    const ctx = {} as ExecutionContext;

    const response = await handleLfsGateBranch(request, env, ctx, engine, route);

    // Identity, not a rebuild: the engine sees the exact request it would
    // have received before the LFS branch existed (method/URL/body and the
    // streamed body undisturbed). The vendored e2e suite's 32/35 allowlist
    // depends on this — its repositories are all D1-missing.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(request);
    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});

// --- batch envelope (§2.2) ------------------------------------------------------

describe("LFS batch envelope (§2.2, upstream error tables)", () => {
  it("415s without the LFS media type (CheckAcceptMediaType)", async () => {
    const fixtures = await seedFixtures();
    const response = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      method: "POST",
      headers: { accept: JSON_LD, "content-type": LFS_MEDIA_TYPE },
      body: JSON.stringify({ operation: "upload", objects: [] }),
    });

    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    expect(await response.json()).toEqual({ message: "Unsupported Media Type" });
  });

  it("accepts the charset-parameterized media type git-lfs sends", async () => {
    const fixtures = await seedFixtures();
    const response = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      method: "POST",
      headers: {
        accept: `${LFS_MEDIA_TYPE}; charset=utf-8`,
        "content-type": LFS_MEDIA_TYPE,
        authorization: basicTokenHeader(fixtures.write),
      },
      body: JSON.stringify({ operation: "upload", objects: [] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ objects: [] });
  });

  it("400s malformed JSON and unknown operations with upstream status texts", async () => {
    const fixtures = await seedFixtures();
    const url = `${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`;
    const auth = { authorization: basicTokenHeader(fixtures.write) };

    const bad = await SELF.fetch(url, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, ...auth },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ message: "Bad Request" });

    const badOp = await SELF.fetch(url, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE, ...auth },
      body: JSON.stringify({ operation: "delete", objects: [] }),
    });
    expect(badOp.status).toBe(400);
    expect(await badOp.json()).toEqual({ message: "Bad Request" });
  });

  it("413s over the batch cap", async () => {
    const fixtures = await seedFixtures();
    const objects = Array.from({ length: DEFAULT_LFS_LIMITS.maxBatchSize + 1 }, () => ({
      oid: "0".repeat(64),
      size: 1,
    }));
    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects,
    }, { authorization: basicTokenHeader(fixtures.write) });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ message: "Request Entity Too Large" });
  });

  it("issues relay upload+verify hrefs and creating rows for absent objects", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(1);
    const oid = await sha256Hex(bytes);
    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, { authorization: basicTokenHeader(fixtures.write) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    const body = await response.json<{
      objects: { oid: string; size: number; actions: Record<string, { href: string; header: Record<string, string> }> }[];
    }>();
    const auth = `Basic ${btoa(`${fixtures.write}:`)}`;
    expect(body.objects).toHaveLength(1);
    expect(body.objects[0]?.oid).toBe(oid);
    expect(body.objects[0]?.actions.upload).toEqual({
      href: `${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/${bytes.byteLength}`,
      header: { Authorization: auth }, // chunked hint dropped (411 conflict, lfs-e2e)
    });
    expect(body.objects[0]?.actions.verify).toEqual({
      href: `${repoUrl(fixtures.privateRepo)}/info/lfs/verify`,
      header: { Accept: LFS_ACCEPT_HEADER, Authorization: auth },
    });
    expect(await lastRowState(lfsRepoIdOf(fixtures.privateRepo), oid)).toBe("uploading");
  });

  it("answers per-object errors without failing the envelope (§4.8)", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(2);
    const oid = await sha256Hex(bytes);
    // A stale row with a different size → the mismatch error for that object.
    await new LfsStateService(env.DB).ensureUploading(lfsRepoIdOf(fixtures.privateRepo), oid, 999, new Date());

    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [
        { oid: "zz", size: 1 },
        { oid, size: bytes.byteLength },
      ],
    }, { authorization: basicTokenHeader(fixtures.write) });

    expect(response.status).toBe(200);
    const body = await response.json<{ objects: { error?: { code: number; message: string } }[] }>();
    expect(body.objects[0]?.error).toEqual({ code: 422, message: "Oid or size are invalid" });
    expect(body.objects[1]?.error).toEqual({
      code: 422,
      message: `Object ${oid} is not ${bytes.byteLength} bytes`,
    });
  });

  it("answers absent downloads with per-object 404 (batch-spec code semantics)", async () => {
    const fixtures = await seedFixtures();
    const oid = await sha256Hex(content(3));
    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [{ oid, size: 128 }],
    }, { authorization: basicTokenHeader(fixtures.write) });

    expect(response.status).toBe(200);
    const body = await response.json<{ objects: { error?: { code: number; message: string } }[] }>();
    expect(body.objects[0]?.error).toEqual({ code: 404, message: "Not Found" });
  });
});

// --- relay roundtrip (real R2 through the router) ---------------------------------

describe("relay roundtrip: batch → PUT → verify → batch download → GET", () => {
  it("runs the full state machine with real R2 bytes (relay hrefs)", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(4, 512);
    const oid = await sha256Hex(bytes);
    const auth = `Basic ${btoa(`${fixtures.write}:`)}`;

    // 1. batch(upload) → relay hrefs, row uploading.
    const batch = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, { authorization: basicTokenHeader(fixtures.write) });
    const shaped = await batch.json<{ objects: { actions: Record<string, { href: string }> }[] }>();
    const uploadHref = shaped.objects[0]?.actions.upload?.href;
    const verifyHref = shaped.objects[0]?.actions.verify?.href;
    expect(uploadHref).toBeDefined();
    expect(verifyHref).toBeDefined();

    // 2. relay PUT streams the bytes with a truthful Content-Length; the 200
    // rides the upstream writeStatus(200) envelope (LFS JSON "OK").
    const put = await SELF.fetch(uploadHref as string, {
      method: "PUT",
      headers: { authorization: auth, "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    expect(await put.json()).toEqual({ message: "OK" });

    // 3. verify flips the row to verified.
    const verify = await SELF.fetch(verifyHref as string, {
      method: "POST",
      headers: {
        accept: LFS_MEDIA_TYPE,
        "content-type": LFS_MEDIA_TYPE,
        authorization: auth,
      },
      body: JSON.stringify({ oid, size: bytes.byteLength }),
    });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ message: "OK" });
    expect(await lastRowState(lfsRepoIdOf(fixtures.privateRepo), oid)).toBe("verified");

    // 4. re-batch: already present ⇒ empty actions (git-lfs skips the transfer).
    const rebatch = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, { authorization: basicTokenHeader(fixtures.write) });
    const reshaped = await rebatch.json<{ objects: { actions: Record<string, unknown> }[] }>();
    expect(reshaped.objects[0]?.actions).toEqual({});

    // 5. batch(download) → relay download href; 6. GET returns identical bytes.
    const downloadBatch = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [{ oid, size: bytes.byteLength }],
    }, { authorization: basicTokenHeader(fixtures.write) });
    const downloadShaped = await downloadBatch.json<{
      objects: { actions: { download?: { href: string; header: Record<string, string> } } }[];
    }>();
    const download = downloadShaped.objects[0]?.actions.download;
    expect(download?.href).toBe(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}`);
    expect(download?.header).toEqual({ Authorization: auth });

    const get = await SELF.fetch(download?.href as string, {
      headers: { authorization: auth },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    expect(get.headers.get("x-gitea-lfs-content-length")).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("422s a hash mismatch, deletes the object, and names the upstream error", async () => {
    const fixtures = await seedFixtures();
    const oid = await sha256Hex(content(5)); // honest oid…
    const lying = content(6); // …but different bytes
    const auth = basicTokenHeader(fixtures.write);
    const url = `${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/${lying.byteLength}`;

    const put = await SELF.fetch(url, {
      method: "PUT",
      headers: { authorization: auth, "content-length": String(lying.byteLength) },
      body: lying,
    });

    expect(put.status).toBe(422);
    expect(await put.json()).toEqual({ message: "content hash does not match OID" });
    expect(await env.REPO_PACKS.head(lfsKey(fixtures.privateRepo.storageKey, oid))).toBeNull();
  });

  it("422s a lying Content-Length against the path size (size mismatch)", async () => {
    const fixtures = await seedFixtures();
    const oid = await sha256Hex(content(7, 64));
    const auth = basicTokenHeader(fixtures.write);

    const put = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/128`, {
      method: "PUT",
      headers: { authorization: auth, "content-length": "64" },
      body: content(7, 64),
    });

    expect(put.status).toBe(422);
    expect(await put.json()).toEqual({ message: "content size does not match" });
    expect(await env.REPO_PACKS.head(lfsKey(fixtures.privateRepo.storageKey, oid))).toBeNull();
  });

  it("411s relay uploads without Content-Length (store needs the length)", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(8);
    const oid = await sha256Hex(bytes);
    const resolved = await resolveRepository(env.DB, "alice", fixtures.privateRepo.slug);
    if (resolved === null) throw new Error("seed failed");

    // Hand-built streaming Request: workerd's SELF.fetch materializes
    // known-length bodies into a synthesized Content-Length header (hiding
    // the branch), while a raw stream Request carries none — exactly what a
    // git-lfs chunked transfer looks like server-side.
    const stream = new Response(bytes).body;
    if (stream === null) throw new Error("no body stream");
    // workerd's RequestInit omits `duplex` from its type (runtime-only);
    // the intersection keeps the literal checkable without a cast.
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers: { authorization: basicTokenHeader(fixtures.write) },
      body: stream,
      duplex: "half",
    };
    const request = new Request(
      `${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/${bytes.byteLength}`,
      init,
    );
    const route = parseLfsRoute(new URL(request.url).pathname, "PUT");
    if (route === null) throw new Error("route parse failed");
    const put = await serveLfs(request, env, () => {}, route, resolved, defaultLfsDeps(env));

    expect(put.status).toBe(411);
    expect(await put.json()).toEqual({ message: "Length Required" });
  });

  it("422s uploads with an invalid pointer path before auth (upstream order)", async () => {
    const fixtures = await seedFixtures();
    const put = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/zz/128`, {
      method: "PUT",
      headers: { authorization: basicTokenHeader(fixtures.write), "content-length": "128" },
      body: content(9, 128),
    });

    expect(put.status).toBe(422);
    expect(await put.json()).toEqual({ message: "Oid or size are invalid" });
  });

  it("skips the body check when the object is present with a matching row", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(10);
    const oid = await sha256Hex(bytes);
    const store = new RelayLfsStore(env.REPO_PACKS);
    const state = new LfsStateService(env.DB);
    await store.put(lfsKey(fixtures.privateRepo.storageKey, oid), bytes, {
      size: bytes.byteLength,
      expectedSha256Hex: oid,
    });
    await state.ensureUploading(lfsRepoIdOf(fixtures.privateRepo), oid, bytes.byteLength, new Date());

    // A PUT whose body proves nothing (wrong bytes, valid length) still 200s —
    // the object is linked to this repo already (upstream server.go:328-339).
    const put = await SELF.fetch(
      `${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/${bytes.byteLength}`,
      {
        method: "PUT",
        headers: { authorization: basicTokenHeader(fixtures.write), "content-length": String(bytes.byteLength) },
        body: content(11),
      },
    );
    expect(put.status).toBe(200);
    // The stored bytes were NOT overwritten by the mismatching body (skip).
    const stat = await store.head(lfsKey(fixtures.privateRepo.storageKey, oid));
    expect(stat?.size).toBe(bytes.byteLength);
  });

  it("verifies 404 for objects that never arrived", async () => {
    const fixtures = await seedFixtures();
    const oid = await sha256Hex(content(12));
    const verify = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/verify`, {
      method: "POST",
      headers: {
        accept: LFS_MEDIA_TYPE,
        "content-type": LFS_MEDIA_TYPE,
        authorization: basicTokenHeader(fixtures.write),
      },
      body: JSON.stringify({ oid, size: 128 }),
    });

    expect(verify.status).toBe(404);
    expect(await verify.json()).toEqual({ message: "Not Found" });
  });

  it("adopts an uploaded-but-unverified object on the next batch (§3.3)", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(13);
    const oid = await sha256Hex(bytes);
    // Upload finished, verify was lost: bytes in R2, no row at all.
    const store = new RelayLfsStore(env.REPO_PACKS);
    await store.put(lfsKey(fixtures.privateRepo.storageKey, oid), bytes, {
      size: bytes.byteLength,
      expectedSha256Hex: oid,
    });

    const batch = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, { authorization: basicTokenHeader(fixtures.write) });
    const body = await batch.json<{ objects: { actions: Record<string, unknown> }[] }>();

    expect(body.objects[0]?.actions).toEqual({});
    expect(await lastRowState(lfsRepoIdOf(fixtures.privateRepo), oid)).toBe("verified");
  });

  it("serves anonymous downloads of a public repo without an Authorization echo", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(14);
    const oid = await sha256Hex(bytes);
    const store = new RelayLfsStore(env.REPO_PACKS);
    await store.put(lfsKey(fixtures.publicRepo.storageKey, oid), bytes, {
      size: bytes.byteLength,
      expectedSha256Hex: oid,
    });
    await new LfsStateService(env.DB).insertVerified(
      lfsRepoIdOf(fixtures.publicRepo),
      oid,
      bytes.byteLength,
      new Date(),
    );

    const batch = await lfsBatch(`${repoUrl(fixtures.publicRepo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [{ oid, size: bytes.byteLength }],
    });
    expect(batch.status).toBe(200);
    const body = await batch.json<{
      objects: { actions: { download: { href: string; header?: Record<string, string> } } }[];
    }>();
    const download = body.objects[0]?.actions.download;
    expect(download?.href).toBe(`${repoUrl(fixtures.publicRepo)}/info/lfs/objects/${oid}`);
    // Upstream `Link.WithHeader` skips empty values — no Authorization key.
    expect(download?.header).toBeUndefined();

    const get = await SELF.fetch(download?.href as string);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });
});

// --- download details -------------------------------------------------------------

describe("relay download details (§2.3)", () => {
  async function seedDownloadable(ordinal: number): Promise<{ fixtures: Fixtures; oid: string; bytes: Uint8Array }> {
    const fixtures = await seedFixtures();
    const bytes = content(ordinal, 256);
    const oid = await sha256Hex(bytes);
    const store = new RelayLfsStore(env.REPO_PACKS);
    await store.put(lfsKey(fixtures.privateRepo.storageKey, oid), bytes, {
      size: bytes.byteLength,
      expectedSha256Hex: oid,
    });
    await new LfsStateService(env.DB).insertVerified(lfsRepoIdOf(fixtures.privateRepo), oid, bytes.byteLength, new Date());
    return { fixtures, oid, bytes };
  }

  it("streams a byte range with 206 + Content-Range (resume support)", async () => {
    const { fixtures, oid, bytes } = await seedDownloadable(21);
    const get = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}`, {
      headers: { authorization: basicTokenHeader(fixtures.write), range: "bytes=10-19" },
    });

    expect(get.status).toBe(206);
    expect(get.headers.get("content-range")).toBe(`bytes 10-19/${bytes.byteLength}`);
    expect(get.headers.get("x-gitea-lfs-content-length")).toBe("10");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes.slice(10, 20));
  });

  it("416s an unsatisfiable range (upstream parseEventArgs statuses)", async () => {
    const { fixtures, oid } = await seedDownloadable(22);
    const get = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}`, {
      headers: { authorization: basicTokenHeader(fixtures.write), range: "bytes=99999-" },
    });

    expect(get.status).toBe(416);
    expect(await get.json()).toEqual({ message: "Requested Range Not Satisfiable" });
  });

  it("sets Content-Disposition from the base64url filename segment", async () => {
    const { fixtures, oid } = await seedDownloadable(23);
    const filename = btoa("report final.bin").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const get = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/${filename}`, {
      headers: { authorization: basicTokenHeader(fixtures.write) },
    });

    expect(get.status).toBe(200);
    expect(get.headers.get("content-disposition")).toBe('attachment; filename="report final.bin"');
  });

  it("ignores an undecodable filename segment instead of reflecting it (§4.14)", async () => {
    const { fixtures, oid } = await seedDownloadable(24);
    const get = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/!!!invalid!!!`, {
      headers: { authorization: basicTokenHeader(fixtures.write) },
    });

    expect(get.status).toBe(200);
    expect(get.headers.get("content-disposition")).toBeNull();
  });

  it("404s a download whose row is missing (or whose oid is junk → 422)", async () => {
    const { fixtures } = await seedDownloadable(25);
    const absent = await sha256Hex(content(26));

    const noRow = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${absent}`, {
      headers: { authorization: basicTokenHeader(fixtures.write) },
    });
    expect(noRow.status).toBe(404);
    expect(await noRow.json()).toEqual({ message: "Not Found" });

    const junk = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/short`, {
      headers: { authorization: basicTokenHeader(fixtures.write) },
    });
    expect(junk.status).toBe(422);
    expect(await junk.json()).toEqual({ message: "Oid or size are invalid" });
  });
});

// --- catch-alls, locks, method mismatches -------------------------------------------

describe("family catch-all and P2 deferrals", () => {
  it("404s junk subpaths, bare /info/lfs and method mismatches — Go stdlib shape", async () => {
    const fixtures = await seedFixtures();
    const auth = { authorization: basicTokenHeader(fixtures.write) };

    // The catch-all is upstream's m.Any("/*", http.NotFound): plain text, not
    // the LFS JSON envelope (which only writeStatusMessage handlers use).
    const junk = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/whatever`, { headers: auth });
    expect(junk.status).toBe(404);
    expect(junk.headers.get("content-type")).toContain("text/plain");
    expect(await junk.text()).toBe("404 page not found\n");

    const bare = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs`, { headers: auth });
    expect(bare.status).toBe(404);
    expect(bare.headers.get("content-type")).toContain("text/plain");

    const wrongMethod = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      method: "GET",
      headers: auth,
    });
    expect(wrongMethod.status).toBe(404);
    expect(wrongMethod.headers.get("content-type")).toContain("text/plain");
  });

  it("answers locks/* with a plain 501 before auth (§2.7 P2)", async () => {
    const fixtures = await seedFixtures();

    const anonymous = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/locks`, { method: "POST" });
    expect(anonymous.status).toBe(501);
    expect(anonymous.headers.get("www-authenticate")).toBeNull();
    expect(await anonymous.json()).toEqual({ message: "Not Implemented" });

    const nested = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/locks/42/unlock`, {
      method: "POST",
    });
    expect(nested.status).toBe(501);
  });
});

// --- presign mode (direct serveLfs pass, same handler code) --------------------------

describe("presign href mode (capability probe, batch roundtrip)", () => {
  it("issues checksum-bound presigned hrefs while verify stays on the Worker", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(31);
    const oid = await sha256Hex(bytes);
    const presign = new PresignLfsStore(
      env.REPO_PACKS,
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDAG/bJEPyPg5m9mQY2glgvmW", accountId: "acct" },
      { bucketName: "cf-gitea-packs", ttlSeconds: 900 },
    );
    const deps = {
      state: new LfsStateService(env.DB),
      store: presign,
      limits: DEFAULT_LFS_LIMITS,
      now: () => new Date("2026-10-24T12:00:00Z"),
    };
    const resolved = await resolveRepository(env.DB, "alice", fixtures.privateRepo.slug);
    if (resolved === null) throw new Error("seed failed");

    const batchRequest = new Request(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE, authorization: basicTokenHeader(fixtures.write) },
      body: JSON.stringify({ operation: "upload", objects: [{ oid, size: bytes.byteLength }] }),
    });
    const route = parseLfsRoute(new URL(batchRequest.url).pathname, "POST");
    if (route === null) throw new Error("route parse failed");
    const batch = await serveLfs(batchRequest, env, () => {}, route, resolved, deps);
    expect(batch.status).toBe(200);

    const body = await batch.json<{
      objects: { actions: Record<string, { href: string; header?: Record<string, string>; expires_in?: number }> }[];
    }>();
    const upload = body.objects[0]?.actions.upload;
    // Presigned PUT: R2 S3 endpoint, checksum header bound AND echoed, TTL.
    expect(upload?.href).toContain(
      `r2.cloudflarestorage.com/cf-gitea-packs/lfs/${fixtures.privateRepo.storageKey}/${oid}`,
    );
    expect(upload?.href).toContain("X-Amz-Signature=");
    expect(upload?.header).toEqual({ "x-amz-checksum-sha256": checksumHeaderFor(oid) });
    expect(upload?.expires_in).toBe(900);
    // The verify hop always stays on the Worker (it flips D1 state).
    expect(body.objects[0]?.actions.verify?.href).toBe(`${repoUrl(fixtures.privateRepo)}/info/lfs/verify`);

    // Simulate the client's presigned PUT: R2 enforces the bound checksum, so
    // a store-level put with the oid bound is the same contract.
    await presign.put(lfsKey(fixtures.privateRepo.storageKey, oid), bytes, {
      size: bytes.byteLength,
      expectedSha256Hex: oid,
    });

    // Verify through the same router pass (presign mode requires the stored
    // checksum to equal the oid).
    const verifyRequest = new Request(`${repoUrl(fixtures.privateRepo)}/info/lfs/verify`, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE, authorization: basicTokenHeader(fixtures.write) },
      body: JSON.stringify({ oid, size: bytes.byteLength }),
    });
    const verifyRoute = parseLfsRoute(new URL(verifyRequest.url).pathname, "POST");
    if (verifyRoute === null) throw new Error("route parse failed");
    const verify = await serveLfs(verifyRequest, env, () => {}, verifyRoute, resolved, deps);
    expect(verify.status).toBe(200);
    expect(await lastRowState(lfsRepoIdOf(fixtures.privateRepo), oid)).toBe("verified");

    // Download batch → bare presigned GET (bearer URL, no headers).
    const downloadRequest = new Request(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE, authorization: basicTokenHeader(fixtures.write) },
      body: JSON.stringify({ operation: "download", objects: [{ oid, size: bytes.byteLength }] }),
    });
    const downloadBatch = await serveLfs(
      downloadRequest,
      env,
      () => {},
      route,
      resolved,
      deps,
    );
    const downloadBody = await downloadBatch.json<{
      objects: { actions: { download?: { href: string; header?: Record<string, string> } } }[];
    }>();
    const download = downloadBody.objects[0]?.actions.download;
    expect(download?.href).toContain("X-Amz-Signature=");
    expect(download?.header).toBeUndefined();
  });
});

// --- helper (kept below the suites for readability) ---------------------------------

/**
 * The numeric repo key the router derives for `lfs_objects.repo_id` (see
 * `lfsRepoId` in ./router — a deterministic 52-bit bridge over the uuid id).
 */
function lfsRepoIdOf(repo: SeededRepo): number {
  return Number.parseInt(repo.id.replaceAll("-", "").slice(0, 13), 16);
}
