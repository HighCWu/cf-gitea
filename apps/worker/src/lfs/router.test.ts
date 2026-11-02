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

import { verifyDeployToken } from "../auth/deploy-token-service";
import { basicHeader, basicTokenHeader, mintFor, resetAuthTables, seedVerifiedUser } from "../auth/testing/seeds";
import { doerRepoAccessMode } from "../api/services/repository";
import { TeamsService } from "../api/routes/org-teams";
import { resolveRepository } from "../git-http/acl";
import { deployKeys, repoCollaborators, repositories, repoRedirects } from "../db/schema";
import { OrgService } from "../services/orgs/orgs";
import {
  DEFAULT_LFS_LIMITS,
  LFS_ACCEPT_HEADER,
  LFS_MEDIA_TYPE,
} from "../services/lfs/batch";
import { LfsLockService } from "../services/lfs/locks";
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
  // Grant tables first (repo_collaborators declares no FK and org tables
  // mirror the gate.test.ts sweep order) — then the auth rows they point at.
  for (const table of ["repo_collaborators", "team_repo_access", "team_members", "teams", "org_members"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await resetAuthTables();
  await env.DB.prepare("DELETE FROM deploy_keys").run();
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
  options: { isArchived?: boolean; ownerId?: number } = {},
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
      ...(options.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
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

/**
 * Mint a `gdt_` deploy-key row bound to a seeded repo — addDeployKeyToken's
 * row shape (sha256 + key_type=2, mode 1|2), seeded locally because this
 * suite pins the LFS side (the auth suite owns the verifier's own pins).
 * The plaintext is returned for the Basic header.
 */
async function seedDeployKeyToken(repoId: string, mode: 1 | 2): Promise<string> {
  const token = `gdt_${`${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "").slice(0, 43)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = new Date();
  await drizzle(env.DB)
    .insert(deployKeys)
    .values({
      keyId: 0,
      repoId,
      name: "deploy",
      keyType: 2,
      fingerprint: `${token.slice(0, 6)}********${token.slice(-2)}`,
      tokenHash,
      mode,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return token;
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
  it("404s a nonexistent repo with the LFS JSON envelope before any auth challenge (L9)", async () => {
    const response = await lfsBatch("https://example.com/nobody/nothing.git/info/lfs/objects/batch", {
      operation: "upload",
      objects: [],
    });

    // Upstream getAuthenticatedRepository (server.go:462-468): the repo
    // lookup arms AFTER decode/operation and BEFORE auth — the LFS family
    // answers its own JSON 404 (no engine passthrough, no challenge).
    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    expect(await response.json()).toEqual({ message: "Not Found" });
  });

  it("404s a renamed repo's old URL — upstream never consults the redirect table (L9)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "newname", "public");
    await drizzle(env.DB)
      .insert(repoRedirects)
      .values({ ownerId: alice.id, ownerNamespace: "alice", lowerName: "oldname", redirectRepoId: repo.id })
      .run();

    // GetRepositoryByOwnerAndName (models/repo/repo.go:747-763) has no
    // LookupRedirect arm: an old URL answers exactly like a never-existing
    // one — the LFS JSON 404, NOT the git-HTTP pipeline's 301 (L9).
    const response = await lfsBatch("https://example.com/alice/oldname.git/info/lfs/objects/batch", {
      operation: "upload",
      objects: [],
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    expect(await response.json()).toEqual({ message: "Not Found" });
  });

  it("the repo-missing 404 still follows the handler's pre-repo arms (a bad oid 422s first)", async () => {
    const oid = await sha256Hex(content(90));
    const download = await SELF.fetch(`https://example.com/nobody/nothing.git/info/lfs/objects/${oid}`, {});
    expect(download.status).toBe(404); // valid oid → past the 422 arm, into the 404
    expect(await download.json()).toEqual({ message: "Not Found" });

    const junk = await SELF.fetch("https://example.com/nobody/nothing.git/info/lfs/objects/short", {});
    expect(junk.status).toBe(422);
    expect(await junk.json()).toEqual({ message: "Oid or size are invalid" });

    const upload = await SELF.fetch("https://example.com/nobody/nothing.git/info/lfs/objects/zz/128", {
      method: "PUT",
      headers: { "content-length": "128" },
      body: "x",
    });
    expect(upload.status).toBe(422); // the strconv/IsValid arms precede the repo lookup
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

  it("challenges (401) when BOTH the grant and the scope fail — authenticate before CheckRepoScopedToken (L7)", async () => {
    // Upstream order (server.go:470-483): authenticate (401) runs before the
    // scope check (403). An outsider's token that ALSO lacks the repository
    // scope therefore challenges — the old scope-first order 403'd here.
    const bob = await seedVerifiedUser({ username: "Bob" });
    const bobWrongScope = (await mintFor(bob.id, "bob-wrong", "write:user")).plaintext;
    const repo = await seedRepo("alice", "closed", "private");

    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [],
    }, { authorization: basicTokenHeader(bobWrongScope) });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
    expect(await response.json()).toEqual({ message: "Unauthorized" });
  });

  it("401s a Bearer ACCESS token — Basic (+ deploy keys) is the family's only credential (L8)", async () => {
    // Upstream mounts AllowBasic + AllowDeployToken, NOT AllowOAuth2
    // (web.go:1777); its parseToken Bearer arm is the internal SSH JWT
    // (server.go:621-630). A Bearer access token reads as anonymous.
    const fixtures = await seedFixtures();
    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [],
    }, { authorization: `Bearer ${fixtures.write}` });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
  });

  it("a Bearer access token on a PUBLIC repo read passes as anonymous — upstream's anonymous arm", async () => {
    // credential-less reads of a publicly visible repo pass (§5 ACL matrix);
    // an unparseable-as-Basic Bearer header is credential-less (L8 posture).
    const fixtures = await seedFixtures();
    const response = await SELF.fetch(`${repoUrl(fixtures.publicRepo)}/info/lfs/objects/batch`, {
      method: "POST",
      headers: {
        accept: LFS_MEDIA_TYPE,
        "content-type": LFS_MEDIA_TYPE,
        authorization: `Bearer ${fixtures.write}`,
      },
      body: JSON.stringify({ operation: "download" }), // no objects key at all
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ objects: null }); // L11: nil objects ⇒ null envelope
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

  // (The renamed-repo arm moved up: it is now the L9 404 test above — the
  // row-13 301 retired with the engine passthrough.)
});

// --- deploy-key tokens on the family (F1, upstream AllowDeployToken) ---------------

describe("deploy-key tokens on the LFS family (F1: upstream mounts the routes WITH AllowDeployToken)", () => {
  /**
   * Upstream chain: web.go:1777 mounts `info/lfs` with `webAuth.AllowDeployToken`
   * (the group adds `&DeployToken{}` before Basic, web.go:131-133), so a Basic
   * `gdt_` credential resolves ctx.Doer to the synthetic key user whose only
   * permission is getDeployKeyRepoPermission (repo_permission.go:387-409) — the
   * key's own repo at its mode. LFS authenticate (server.go:544) then tests
   * CanAccess(Read|Write, code); everything else is the zero-perm arm → the
   * family challenge (401, gitea-lfs realm — no public arm for the key user).
   */

  /** Owner-verifiable object (store+row), so download arms have something to serve. */
  async function seedDownloadable(repo: SeededRepo, ordinal: number): Promise<{ oid: string; bytes: Uint8Array }> {
    const bytes = content(ordinal, 256);
    const oid = await sha256Hex(bytes);
    const store = new RelayLfsStore(env.REPO_PACKS);
    await store.put(lfsKey(repo.storageKey, oid), bytes, {
      size: bytes.byteLength,
      expectedSha256Hex: oid,
    });
    await new LfsStateService(env.DB).insertVerified(lfsRepoIdOf(repo), oid, bytes.byteLength, new Date());
    return { oid, bytes };
  }

  it("passes the F1 repro: the same gdt_ token that clones answers batch download on its own repo", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "deployed", "private");
    const { oid } = await seedDownloadable(repo, 41);
    const token = await seedDeployKeyToken(repo.id, 2);

    // The smoke repro's exact header shape: Basic `deploy:<gdt_…>`.
    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [{ oid, size: 256 }],
    }, { authorization: basicHeader("deploy", token) });

    expect(response.status).toBe(200);
    const body = await response.json<{
      objects: { actions: { download?: { href: string; header: Record<string, string> } } }[];
    }>();
    const download = body.objects[0]?.actions.download;
    expect(download?.href).toBe(`${repoUrl(repo)}/info/lfs/objects/${oid}`);
    // The href echoes the credential exactly like upstream's
    // `NewLink(...).WithHeader("Authorization", rc.Authorization)`.
    expect(download?.header).toEqual({ Authorization: `Basic ${btoa(`deploy:${token}`)}` });
  });

  it("also accepts the token-as-username form (empty password / x-oauth-basic)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "deployed", "private");
    const token = await seedDeployKeyToken(repo.id, 1);

    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [],
    }, { authorization: basicTokenHeader(token) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ objects: [] });
  });

  it("a read-mode key serves GET download of its own repo but not the upload op", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "deployed", "private");
    const { oid, bytes } = await seedDownloadable(repo, 42);
    const token = await seedDeployKeyToken(repo.id, 1);

    const uploadOp = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, { authorization: basicTokenHeader(token) });
    expect(uploadOp.status).toBe(401); // zero-perm arm: read-only key on a write route
    expect(uploadOp.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
    expect(await uploadOp.json()).toEqual({ message: "Unauthorized" });

    const get = await SELF.fetch(`${repoUrl(repo)}/info/lfs/objects/${oid}`, {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("x-gitea-lfs-content-length")).toBe("256");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("a write-mode key runs the upload state machine: batch hrefs → PUT → verify", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "deployed", "private");
    const bytes = content(43, 512);
    const oid = await sha256Hex(bytes);
    const token = await seedDeployKeyToken(repo.id, 2);
    const auth = { authorization: basicHeader("deploy", token) };

    const batch = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, auth);
    expect(batch.status).toBe(200);
    const shaped = await batch.json<{ objects: { actions: Record<string, { href: string }> }[] }>();
    const uploadHref = shaped.objects[0]?.actions.upload?.href;
    const verifyHref = shaped.objects[0]?.actions.verify?.href;
    expect(uploadHref).toBeDefined();
    expect(verifyHref).toBeDefined();

    const put = await SELF.fetch(uploadHref as string, {
      method: "PUT",
      headers: { ...auth, "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ message: "OK" });

    const verify = await SELF.fetch(verifyHref as string, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE, ...auth },
      body: JSON.stringify({ oid, size: bytes.byteLength }),
    });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ message: "OK" });
    expect(await lastRowState(lfsRepoIdOf(repo), oid)).toBe("verified");
  });

  it("a FOREIGN repo's key gets the zero-perm challenge — a public repo included (no anonymous arm for the key user)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    await seedVerifiedUser({ username: "Bob" });
    const bobPublic = await seedRepo("bob", "public-lfs", "public");
    const bobPrivate = await seedRepo("bob", "private-lfs", "private");
    const { oid, bytes } = await seedDownloadable(bobPublic, 44);
    const aliceOwn = await seedRepo("alice", "own", "private");
    const readToken = await seedDeployKeyToken(aliceOwn.id, 1); // alice's own repo, pointed at BOB's routes
    const writeToken = await seedDeployKeyToken(aliceOwn.id, 2);

    const foreignPublicRead = await lfsBatch(
      `${repoUrl(bobPublic)}/info/lfs/objects/batch`,
      { operation: "download", objects: [{ oid, size: bytes.byteLength }] },
      { authorization: basicTokenHeader(readToken) },
    );
    expect(foreignPublicRead.status).toBe(401);
    expect(foreignPublicRead.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');

    const foreignPrivateWrite = await lfsBatch(
      `${repoUrl(bobPrivate)}/info/lfs/objects/batch`,
      { operation: "upload", objects: [] },
      { authorization: basicTokenHeader(writeToken) },
    );
    expect(foreignPrivateWrite.status).toBe(401);
    expect(await foreignPrivateWrite.json()).toEqual({ message: "Unauthorized" });
  });

  it("401s an unknown gdt_ value (falls through; no identity)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "deployed", "private");
    const unknown = `gdt_${"9".repeat(43)}`;

    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [],
    }, { authorization: basicTokenHeader(unknown) });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
  });

  it("401s `Bearer gdt_…` — the deploy method parses only the Basic header", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "deployed", "private");
    const token = await seedDeployKeyToken(repo.id, 2);

    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [],
    }, { authorization: `Bearer ${token}` });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
  });

  it("an archived own repo refuses the write-armed key (§4.11 family posture)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "frozen", "private", { isArchived: true });
    const token = await seedDeployKeyToken(repo.id, 2);

    const response = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [],
    }, { authorization: basicTokenHeader(token) });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("archived");
  });

  it("leaves a fresh key's last-used stamp alone (the throttled UpdateDeployKeyLastUsed touch)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const repo = await seedRepo("alice", "deployed", "private");
    const token = await seedDeployKeyToken(repo.id, 1);
    const before = await verifyDeployToken(env.DB, token);
    // The seed stamps now; the 24 h throttle means this request must NOT touch.
    expect(before?.updatedAt.getTime()).toBeCloseTo(Date.now(), -4);

    await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [],
    }, { authorization: basicTokenHeader(token) });

    const after = await verifyDeployToken(env.DB, token);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });
});

// --- collaborator + org-team grants (the git-HTTP grant fold) --------------------

describe("collaborator and org-team grants on the LFS family (SPEC-0007 §3.5 + SPEC-0005)", () => {
  /**
   * `authorizeLfs` resolves the SAME repository-service grant the git-HTTP
   * gate consumes (`doerRepoAccessMode` — the SPEC-0007 §3.5 org/team arms
   * + the SPEC-0005 collaborator row; upstream LFS `authenticate` consults
   * the full GetDoerRepoPermission fold, server.go:551-557). A collaborator
   * or org-team member who can git push can git lfs push too; a read grant
   * downloads but never uploads; an outsider on a private repo still 401s.
   */

  /** The SPEC-0005 collaborator row, seeded at the requested mode. */
  async function seedCollaborator(repoId: string, userId: number, mode: "read" | "write"): Promise<void> {
    await drizzle(env.DB).insert(repoCollaborators).values({ repoId, userId, mode }).run();
  }

  /** Owner-verifiable object (store+row), so read arms have something to serve. */
  async function seedDownloadable(
    repo: SeededRepo,
    ordinal: number,
  ): Promise<{ oid: string; bytes: Uint8Array }> {
    const bytes = content(ordinal, 256);
    const oid = await sha256Hex(bytes);
    const store = new RelayLfsStore(env.REPO_PACKS);
    await store.put(lfsKey(repo.storageKey, oid), bytes, {
      size: bytes.byteLength,
      expectedSha256Hex: oid,
    });
    await new LfsStateService(env.DB).insertVerified(lfsRepoIdOf(repo), oid, bytes.byteLength, new Date());
    return { oid, bytes };
  }

  /** The full git-lfs write roundtrip with one credential. */
  async function runWriteLadder(
    repo: SeededRepo,
    token: string,
    ordinal: number,
  ): Promise<void> {
    const bytes = content(ordinal, 256);
    const oid = await sha256Hex(bytes);
    const auth = { authorization: basicTokenHeader(token) };

    const batch = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, auth);
    expect(batch.status).toBe(200);
    const shaped = await batch.json<{ objects: { actions: Record<string, { href: string }> }[] }>();
    const uploadHref = shaped.objects[0]?.actions.upload?.href;
    const verifyHref = shaped.objects[0]?.actions.verify?.href;
    expect(uploadHref).toBeDefined();
    expect(verifyHref).toBeDefined();

    const put = await SELF.fetch(uploadHref as string, {
      method: "PUT",
      headers: { ...auth, "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ message: "OK" });

    const verify = await SELF.fetch(verifyHref as string, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE, ...auth },
      body: JSON.stringify({ oid, size: bytes.byteLength }),
    });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ message: "OK" });
    expect(await lastRowState(lfsRepoIdOf(repo), oid)).toBe("verified");
  }

  it("a write-collaborator runs the full write ladder: batch(upload) → PUT → verify", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const repo = await seedRepo("alice", "shared", "private");
    await seedCollaborator(repo.id, bob.id, "write");
    const bobWrite = (await mintFor(bob.id, "w", "write:repository")).plaintext;

    // The fixture rows are exactly what the fold reads — one cross-check
    // against the service layer (the full matrix lives in repository.test.ts).
    expect(await doerRepoAccessMode(env.DB, { id: repo.id, ownerId: null }, bob.id)).toBe("write");
    expect(await doerRepoAccessMode(env.DB, { id: repo.id, ownerId: alice.id }, bob.id)).toBe("write");

    await runWriteLadder(repo, bobWrite, 51);
  });

  it("an org-team write member runs the same ladder on an org-owned private repo", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const orgs = new OrgService(env.DB);
    const teams = new TeamsService(env.DB);
    const org = await orgs.createOrg({ name: "acme", ownerId: alice.id });
    // ownerId set — the team arm resolves through it (orgs.ts teamRepoAccessMode).
    const repo = await seedRepo("acme", "vault", "private", { ownerId: org.id });
    const writers = await teams.createTeam(org, { name: "writers", permission: "write" });
    await teams.addTeamRepo(writers, repo.id);
    await teams.addTeamMember(writers, bob.id);
    const bobWrite = (await mintFor(bob.id, "w", "write:repository")).plaintext;

    expect(await doerRepoAccessMode(env.DB, { id: repo.id, ownerId: org.id }, bob.id)).toBe("write");

    await runWriteLadder(repo, bobWrite, 52);
  });

  it("a read-collaborator downloads but cannot upload (write-scope token: the GRANT is the blocker)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const repo = await seedRepo("alice", "readonly", "private");
    await seedCollaborator(repo.id, bob.id, "read");
    // Write scope on purpose: a read-scope token would stop at the scope
    // check (plain 403) before the grant rows — the 401 below is the
    // grant-arm challenge, upstream's authenticate-false outcome.
    const bobWrite = (await mintFor(bob.id, "w", "write:repository")).plaintext;
    const { oid, bytes } = await seedDownloadable(repo, 53);
    const auth = { authorization: basicTokenHeader(bobWrite) };

    const download = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [{ oid, size: bytes.byteLength }],
    }, auth);
    expect(download.status).toBe(200);
    const shaped = await download.json<{
      objects: { actions: { download?: { href: string } } }[];
    }>();
    expect(shaped.objects[0]?.actions.download?.href).toBe(
      `${repoUrl(repo)}/info/lfs/objects/${oid}`,
    );
    const get = await SELF.fetch(shaped.objects[0]?.actions.download?.href as string, { headers: auth });
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

    const upload = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, auth);
    expect(upload.status).toBe(401);
    expect(upload.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
    expect(await upload.json()).toEqual({ message: "Unauthorized" });
  });

  it("an org-team read member downloads but cannot upload, like the read collaborator", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const orgs = new OrgService(env.DB);
    const teams = new TeamsService(env.DB);
    const org = await orgs.createOrg({ name: "acme", ownerId: alice.id });
    const repo = await seedRepo("acme", "vault", "private", { ownerId: org.id });
    const readers = await teams.createTeam(org, { name: "readers", permission: "read" });
    await teams.addTeamRepo(readers, repo.id);
    await teams.addTeamMember(readers, bob.id);
    const bobWrite = (await mintFor(bob.id, "w", "write:repository")).plaintext;
    const { oid, bytes } = await seedDownloadable(repo, 54);
    const auth = { authorization: basicTokenHeader(bobWrite) };

    const download = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [{ oid, size: bytes.byteLength }],
    }, auth);
    expect(download.status).toBe(200);

    const upload = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, auth);
    expect(upload.status).toBe(401);
    expect(upload.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
  });

  it("an outsider on a private repo still 401s on both operations (no grant resolves)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const repo = await seedRepo("alice", "closed", "private");
    const bobWrite = (await mintFor(bob.id, "w", "write:repository")).plaintext;
    const auth = { authorization: basicTokenHeader(bobWrite) };

    const upload = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [],
    }, auth);
    expect(upload.status).toBe(401);
    expect(upload.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');

    const download = await lfsBatch(`${repoUrl(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [],
    }, auth);
    expect(download.status).toBe(401);
  });
});

// --- gate branch: D1-missing repos are the family's own arms (L9) -------------------

describe("handleLfsGateBranch repo-missing arms (L9 — the engine passthrough retired)", () => {
  it("answers the family arms for a D1-missing repo; the engine is never consulted", async () => {
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
    // The branch now touches exactly one ctx member (its waitUntil) — the
    // stub carries it (cf. webhooks/dlq.test.ts's stub-ctx convention).
    const ctx = Object.assign({} as ExecutionContext, {
      waitUntil: (): void => {},
    });

    const response = await handleLfsGateBranch(request, env, ctx, engine, route);

    // Upstream's LFS handlers own the whole subtree (server.go:462-468): the
    // repo-missing batch 404s with the LFS JSON envelope, the engine never
    // sees the request.
    expect(seen).toHaveLength(0);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    expect(await response.json()).toEqual({ message: "Not Found" });
  });

  it("a missing repo's LOCKS route 401s with the route message before any auth (locks.go:51-59, L9)", async () => {
    const list = await SELF.fetch("https://example.com/nobody/nothing.git/info/lfs/locks", {
      headers: { accept: LFS_MEDIA_TYPE },
    });
    expect(list.status).toBe(401);
    expect(list.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
    expect(list.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await list.json()).toEqual({ message: "You must have pull access to list locks" });

    const unlock = await SELF.fetch("https://example.com/nobody/nothing.git/info/lfs/locks/1/unlock", {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE },
      body: "{}",
    });
    expect(unlock.status).toBe(401);
    expect(await unlock.json()).toEqual({ message: "You must have push access to delete locks" });

    // The catch-all keeps its stdlib shape (route match only — no repo lookup).
    const junk = await SELF.fetch("https://example.com/nobody/nothing.git/info/lfs/whatever", {});
    expect(junk.status).toBe(404);
    expect(await junk.text()).toBe("404 page not found\n");
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

  it("emits the {objects} envelope COMPACT with no trailing newline (the pin's jsonv2 MarshalWrite)", async () => {
    const fixtures = await seedFixtures();
    const response = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [],
    }, { authorization: basicTokenHeader(fixtures.write) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    const text = await response.text();
    expect(text).toBe('{"objects":[]}'); // byte-exact compact envelope
    expect(text.endsWith("\n")).toBe(false); // MarshalWrite appends nothing — locks-family wire parity
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

  it("issues relay upload+verify hrefs for absent objects WITHOUT creating rows (L5)", async () => {
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
    // Upstream rows arise only in UploadHandler (server.go:369) — batched
    // hrefs ride against a rowless key; the PUT creates the row.
    expect(await lastRowState(lfsRepoIdOf(fixtures.privateRepo), oid)).toBeNull();
  });

  it("emits {\"objects\":null} when the request omits or nulls the objects key (L11, shared.go:49-52)", async () => {
    const fixtures = await seedFixtures();
    const auth = { authorization: basicTokenHeader(fixtures.write) };
    const url = `${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`;

    const absent = await SELF.fetch(url, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE, ...auth },
      body: JSON.stringify({ operation: "upload" }),
    });
    expect(absent.status).toBe(200);
    expect(await absent.text()).toBe('{"objects":null}'); // byte-exact nil slice

    const nulled = await SELF.fetch(url, {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE, ...auth },
      body: '{"operation":"upload","objects":null}',
    });
    expect(nulled.status).toBe(200);
    expect(await nulled.text()).toBe('{"objects":null}');
  });

  it("413 comes AFTER auth: an anonymous over-cap batch challenges instead (L10, server.go:214-222)", async () => {
    const fixtures = await seedFixtures();
    const objects = Array.from({ length: DEFAULT_LFS_LIMITS.maxBatchSize + 1 }, () => ({
      oid: "0".repeat(64),
      size: 1,
    }));
    const anonymous = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects,
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
  });

  it("answers per-object errors without failing the envelope (§4.8)", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(2);
    const oid = await sha256Hex(bytes);
    // A stale row with a different size → the mismatch error for that object
    // (rows can only get here via the PUT handler; the size it recorded then
    // can disagree with a fresh batch's declaration, upstream server.go:251-257).
    await new LfsStateService(env.DB).insertVerified(lfsRepoIdOf(fixtures.privateRepo), oid, 999, new Date());

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

    // 1. batch(upload) → relay hrefs; NO row yet (L5 — rows arise at the PUT).
    const batch = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, { authorization: basicTokenHeader(fixtures.write) });
    expect(await lastRowState(lfsRepoIdOf(fixtures.privateRepo), oid)).toBeNull();
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

  it("answers the relay PUT with the byte-exact writeStatus(200) body — compact, no trailing newline", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(7);
    const oid = await sha256Hex(bytes);
    const auth = `Basic ${btoa(`${fixtures.write}:`)}`;

    const batch = await lfsBatch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid, size: bytes.byteLength }],
    }, { authorization: basicTokenHeader(fixtures.write) });
    const shaped = await batch.json<{ objects: { actions: Record<string, { href: string }> }[] }>();
    const uploadHref = shaped.objects[0]?.actions.upload?.href;
    expect(uploadHref).toBeDefined();

    // The upload 200 rides the shared `lfsError` writeStatus helper — the same
    // emitter as every upload/verify arm — so its bytes pin the whole family's
    // writeStatus wire: compact `{"message":"OK"}`, no trailing newline (the
    // pin's jsonv2 `MarshalWrite` appends nothing, matching the locks family).
    const put = await SELF.fetch(uploadHref as string, {
      method: "PUT",
      headers: { authorization: auth, "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    const text = await put.text();
    expect(text).toBe('{"message":"OK"}'); // byte-exact writeStatus(200)
    expect(text.endsWith("\n")).toBe(false);
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

  it("422s uploads with an invalid oid path before auth — writeStatus status text (L12)", async () => {
    const fixtures = await seedFixtures();
    const put = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/zz/128`, {
      method: "PUT",
      headers: { authorization: basicTokenHeader(fixtures.write), "content-length": "128" },
      body: content(9, 128),
    });

    // Upstream UploadHandler's IsValid arm is writeStatus(422) — the bare
    // status text, NOT getAuthenticatedMeta's "Oid or size are invalid"
    // (server.go:315-318 vs :443; the ledger L12 correction).
    expect(put.status).toBe(422);
    expect(await put.json()).toEqual({ message: "Unprocessable Entity" });
  });

  it("422s non-integer size segments with the Go strconv NumError text (L12)", async () => {
    const fixtures = await seedFixtures();
    const oid = await sha256Hex(content(9, 128));
    const auth = { authorization: basicTokenHeader(fixtures.write) };

    const junk = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/abc`, {
      method: "PUT",
      headers: { ...auth, "content-length": "128" },
      body: content(9, 128),
    });
    expect(junk.status).toBe(422);
    expect(await junk.json()).toEqual({ message: 'strconv.ParseInt: parsing "abc": invalid syntax' });

    // Out of int64 range — Go's range error text.
    const huge = await SELF.fetch(
      `${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/99999999999999999999`,
      { method: "PUT", headers: { ...auth, "content-length": "128" }, body: content(9, 128) },
    );
    expect(huge.status).toBe(422);
    expect(await huge.json()).toEqual({
      message: 'strconv.ParseInt: parsing "99999999999999999999": value out of range',
    });

    // A negative size PARSES (Go accepts the sign) and then fails IsValid →
    // the status-text arm. (Upstream then forgets to return and continues —
    // the missing-return bug we deliberately do NOT replicate, server.go:311-313.)
    const negative = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/-1`, {
      method: "PUT",
      headers: { ...auth, "content-length": "128" },
      body: content(9, 128),
    });
    expect(negative.status).toBe(422);
    expect(await negative.json()).toEqual({ message: "Unprocessable Entity" });

    // `+128` is a VALID Go integer — the signed size parses, passes IsValid,
    // and the honest upload completes with the row insert (the L4-adjacent
    // ParseInt sign leniency on the wire; the raw {size} segment carries the
    // literal plus).
    const signed = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/+128`, {
      method: "PUT",
      headers: { ...auth, "content-length": "128" },
      body: content(9, 128),
    });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ message: "OK" });
    expect(await lastRowState(lfsRepoIdOf(fixtures.privateRepo), oid)).toBe("uploading");
  });

  it("skips the body check whenever a row exists with the bytes present — sizes never compared (L6)", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(10);
    const oid = await sha256Hex(bytes);
    const store = new RelayLfsStore(env.REPO_PACKS);
    const state = new LfsStateService(env.DB);
    await store.put(lfsKey(fixtures.privateRepo.storageKey, oid), bytes, {
      size: bytes.byteLength,
      expectedSha256Hex: oid,
    });
    await state.insertUploadingIfAbsent(lfsRepoIdOf(fixtures.privateRepo), oid, bytes.byteLength, new Date());

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

    // Even a DISAGREEING declared size skips (no re-hash, no row refresh):
    // upstream checks only `meta == nil` for the body proof and
    // NewLFSMetaObject is insert-if-absent — the row keeps its original size
    // and state (the ledger L6 correction; the old code re-hashed and
    // refreshed the row here).
    const lying = await SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/999999`, {
      method: "PUT",
      headers: { authorization: basicTokenHeader(fixtures.write), "content-length": "6" },
      body: content(11, 6),
    });
    expect(lying.status).toBe(200);
    const row = await state.get(lfsRepoIdOf(fixtures.privateRepo), oid);
    expect(row).toMatchObject({ size: bytes.byteLength, state: "uploading" });
    const statAfter = await store.head(lfsKey(fixtures.privateRepo.storageKey, oid));
    expect(statAfter?.size).toBe(bytes.byteLength);
  });

  it("creates the row at the PUT (insert-if-absent) and leaves an existing row untouched (L5/L6)", async () => {
    const fixtures = await seedFixtures();
    const bytes = content(12);
    const oid = await sha256Hex(bytes);
    const store = new RelayLfsStore(env.REPO_PACKS);
    const state = new LfsStateService(env.DB);
    const auth = { authorization: basicTokenHeader(fixtures.write) };
    const put = (sizeDecl: number, body: Uint8Array): Promise<Response> =>
      SELF.fetch(`${repoUrl(fixtures.privateRepo)}/info/lfs/objects/${oid}/${sizeDecl}`, {
        method: "PUT",
        headers: { ...auth, "content-length": String(body.byteLength) },
        body,
      });

    // First PUT: bytes absent → hash-and-forward → the row arises HERE
    // (upstream server.go:369 — the family's only row creator).
    const first = await put(bytes.byteLength, bytes);
    expect(first.status).toBe(200);
    expect(await state.get(lfsRepoIdOf(fixtures.privateRepo), oid)).toMatchObject({
      size: bytes.byteLength,
      state: "uploading",
    });

    // Bytes now present + row present: a second PUT with a DIFFERENT declared
    // size skips the body check AND the row write — no refresh, no demotion.
    const second = await put(123456, content(12, 6));
    expect(second.status).toBe(200);
    expect(await state.get(lfsRepoIdOf(fixtures.privateRepo), oid)).toMatchObject({
      size: bytes.byteLength,
      state: "uploading",
    });
    expect((await store.head(lfsKey(fixtures.privateRepo.storageKey, oid)))?.size).toBe(bytes.byteLength);
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

  it("404s locks method mismatches via the catch-all, 415s matched routes without Accept", async () => {
    // Method mismatches never reach the locks group's media-type middleware —
    // they fall to the family catch-all (chi: no route in the group matches),
    // plain-text like every other unregistered subpath.
    const fixtures = await seedFixtures();
    const auth = { authorization: basicTokenHeader(fixtures.write) };
    const base = `${repoUrl(fixtures.privateRepo)}/info/lfs/locks`;

    const wrongMethod = await SELF.fetch(`${base}/verify`, { method: "GET", headers: auth });
    expect(wrongMethod.status).toBe(404);
    expect(await wrongMethod.text()).toBe("404 page not found\n");

    const junk = await SELF.fetch(`${base}/42`, { method: "POST", headers: auth });
    expect(junk.status).toBe(404);
    expect(await junk.text()).toBe("404 page not found\n");

    // A matched route with a foreign Accept 415s before auth (the group's
    // CheckAcceptMediaType) — anonymous, still 415.
    const noAccept = await SELF.fetch(base, { method: "POST" });
    expect(noAccept.status).toBe(415);
    expect(noAccept.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await noAccept.json()).toEqual({ message: "Unsupported Media Type" });
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
      locks: new LfsLockService(env.DB),
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
