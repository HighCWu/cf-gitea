/**
 * The archive + languages read routes on REAL engine content (SPEC-0004 §2.4
 * rows repoGetArchive / repoGetLanguages). The routes mount LOCALLY (the
 * tier-2 compat pattern — the router.ts one-liner is REG-MERGE-2's seam), the
 * repo seeds through the real receive flow (ui/testing seed-repo).
 *
 * Pinned here: the tar.gz round-trip (ustar headers, lowercase repo prefix,
 * gzip magic, commit-time mtimes, symlink/exec modes), the zip structure
 * (STORE entries, central directory, EOCD), the `path` subpath filter, the
 * upstream `unknown format` 400 / `unrecognized repository reference` 404
 * (empty repositories land there too), the multi-segment-ref catchall, the
 * Nix immutable Link header, and the languages map (bytes per language,
 * descending, {} for an empty repo).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo } from "../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { users } from "../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerArchiveRoutes } from "./routes/archive";
import { registerLanguageRoutes } from "./routes/languages";
import { engineCell, ZERO_OID } from "./services/engine";
import { RepoService } from "../repos/service";
import type { User } from "./models/user";

const ORIGIN = "https://archive-suite.test";
const TOKEN = "archive-suite-token";
const OWNER = "archiver";
const SLUG = "archive-me";
const REPO_PATH = `/repos/${OWNER}/${SLUG}`;
const T0 = 1_765_000_000;

const SEED_COMMITS = [
  {
    message: "seed: layout",
    time: T0,
    files: [
      { path: "README.md", content: "# archive suite\n" },
      { path: "main.go", content: "package main\n" },
      { path: "src/lib.py", content: "print('lib')\n" },
      { path: "notes.txt", content: "text notes\n" },
    ],
  },
];

let OWNER_ID = 1;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS });
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (row === undefined) throw new Error("seed owner missing");
  OWNER_ID = row.id;
});

function identity(): User {
  return { ...STUB_USER, id: OWNER_ID, login: OWNER, full_name: OWNER, created: new Date(T0 * 1000).toISOString() };
}

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(token === TOKEN ? identity() : null) };

function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  const requireAuth = createTokenAuthMiddleware(resolver);
  const optionalAuth = createOptionalTokenAuthMiddleware(resolver);
  registerArchiveRoutes(a, requireAuth, optionalAuth);
  registerLanguageRoutes(a, requireAuth, optionalAuth);
  return a;
}

const fetchRoute = (path: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(app().fetch(new Request(`${ORIGIN}${path}`, init), env));

/** The parsed body of an in-process response (the house JSON.parse pattern). */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tiny tar/zip parsers (assertion helpers)
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  typeflag: string;
  linkname: string;
  content: string;
}

function parseTar(bytes: Uint8Array): TarEntry[] {
  const decoder = new TextDecoder();
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const mode = Number.parseInt(decoder.decode(header.subarray(100, 108)).replace(/\0.*$/, ""), 8);
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, ""), 8);
    const mtime = Number.parseInt(decoder.decode(header.subarray(136, 148)).replace(/\0.*$/, ""), 8);
    const typeflag = String.fromCharCode(header[156] ?? 48);
    const linkname = decoder.decode(header.subarray(157, 257)).replace(/\0.*$/, "");
    const dataStart = offset + 512;
    entries.push({
      name,
      mode,
      size,
      mtime,
      typeflag,
      linkname,
      content: typeflag === "0" ? decoder.decode(bytes.subarray(dataStart, dataStart + size)) : "",
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

interface ZipEntry {
  name: string;
  method: number;
  mode: number;
  content: string;
}

function parseZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  // locate the EOCD (scan the last 64 KiB)
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no EOCD");
  const count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = view.getUint16(cdOffset + 10, true);
    const externalAttrs = view.getUint32(cdOffset + 38, true);
    const localOffset = view.getUint32(cdOffset + 42, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const name = decoder.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
    const localNameLen = view.getUint16(localOffset + 26, true);
    const size = view.getUint32(localOffset + 22, true);
    const dataStart = localOffset + 30 + localNameLen;
    entries.push({
      name,
      method,
      mode: (externalAttrs >>> 16) & 0xffff,
      content: decoder.decode(bytes.subarray(dataStart, dataStart + size)),
    });
    cdOffset += 46 + nameLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/archive/{archive}
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/archive/{archive} (repoGetArchive)", () => {
  it("streams a tar.gz of the branch: ustar entries under the lowercase repo prefix, gzip magic, commit-time mtimes", async () => {
    const res = await fetchRoute(`${REPO_PATH}/archive/main.tar.gz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${SLUG}-main.tar.gz"`);

    const gz = new Uint8Array(await res.arrayBuffer());
    expect(gz[0]).toBe(0x1f); // gzip magic
    expect(gz[1]).toBe(0x8b);
    const tarBytes = new Uint8Array(
      await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
    );
    const entries = parseTar(tarBytes);
    expect(entries.map((e) => e.name).sort()).toEqual([
      `${SLUG}/README.md`,
      `${SLUG}/main.go`,
      `${SLUG}/notes.txt`,
      `${SLUG}/src/lib.py`,
    ]);
    const readme = entries.find((e) => e.name === `${SLUG}/README.md`);
    expect(readme).toMatchObject({ typeflag: "0", mode: 0o644, size: SEED_COMMITS[0]?.files[0]?.content.length, mtime: T0 });
    expect(readme?.content).toBe("# archive suite\n");
    const python = entries.find((e) => e.name === `${SLUG}/src/lib.py`);
    expect(python?.content).toBe("print('lib')\n");

    // the Nix immutable-rev Link header keys the RESOLVED commit oid
    const link = res.headers.get("Link") ?? "";
    expect(link).toMatch(new RegExp(`^<${ORIGIN}/api/v1/repos/${OWNER}/${SLUG}/archive/[0-9a-f]{40}\\.tar\\.gz\\?rev=[0-9a-f]{40}>; rel="immutable"$`, "u"));
  });

  it("streams a zip of the branch: STORE entries, central directory, exec modes preserved", async () => {
    const res = await fetchRoute(`${REPO_PATH}/archive/main.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const entries = parseZip(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => e.name).sort()).toEqual([
      `${SLUG}/README.md`,
      `${SLUG}/main.go`,
      `${SLUG}/notes.txt`,
      `${SLUG}/src/lib.py`,
    ]);
    for (const entry of entries) {
      expect(entry.method).toBe(0); // STORE
      expect(entry.mode & 0o170000).toBe(0o100000); // regular files
    }
    const go = entries.find((e) => e.name === `${SLUG}/main.go`);
    expect(go?.content).toBe("package main\n");
  });

  it("filters by the `path` subpath query (git archive pathspec semantics, full paths kept)", async () => {
    const res = await fetchRoute(`${REPO_PATH}/archive/main.tar.gz?path=src`);
    expect(res.status).toBe(200);
    const gz = new Uint8Array(await res.arrayBuffer());
    const tarBytes = new Uint8Array(
      await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
    );
    const entries = parseTar(tarBytes);
    expect(entries.map((e) => e.name)).toEqual([`${SLUG}/src/lib.py`]);
  });

  it("serves multi-segment refs through the wildcard catchall", async () => {
    // land refs/heads/feature/one at the branch tip (the API-layer write RPC)
    const refs = await engineCell(env, { ownerNamespace: OWNER.toLowerCase(), slug: SLUG }).listRefs();
    const tip = refs.refs.find((r) => r.name === "refs/heads/main")?.target;
    expect(tip).toBeDefined();
    const landed = await engineCell(env, { ownerNamespace: OWNER.toLowerCase(), slug: SLUG }).commitApiChange({
      ref: "refs/heads/feature/one",
      expectedOldOid: ZERO_OID,
      newOid: tip as string,
    });
    expect(landed.tag).toBe("committed");

    const res = await fetchRoute(`${REPO_PATH}/archive/feature/one.tar.gz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${SLUG}-feature-one.tar.gz"`);
    const gz = new Uint8Array(await res.arrayBuffer());
    const tarBytes = new Uint8Array(
      await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
    );
    expect(parseTar(tarBytes)).toHaveLength(4);
  });

  it("answers the upstream 400 for unknown archive formats", async () => {
    const res = await fetchRoute(`${REPO_PATH}/archive/main.rar`);
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ message: "unknown format: main.rar", url: `${ORIGIN}/api/swagger` });
  });

  it("answers the upstream 404 for an unresolvable ref and refuses bundle archives", async () => {
    const missing = await fetchRoute(`${REPO_PATH}/archive/ghost.tar.gz`);
    expect(missing.status).toBe(404);
    expect(await jsonBody(missing)).toEqual({
      message: "unrecognized repository reference: ghost",
      url: `${ORIGIN}/api/swagger`,
    });

    const bundle = await fetchRoute(`${REPO_PATH}/archive/main.bundle`);
    expect(bundle.status).toBe(400);
    expect(String((await jsonBody(bundle)).message)).toContain("not supported");
  });

  it("404s a missing repository with the anti-enumeration body", async () => {
    const res = await fetchRoute("/repos/archiver/ghost-repo/archive/main.tar.gz");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ message: "not found", url: `${ORIGIN}/api/swagger` });
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/languages
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/languages (repoGetLanguages)", () => {
  it("returns bytes per language over the seeded tree, descending", async () => {
    const res = await fetchRoute(`${REPO_PATH}/languages`);
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as Record<string, number>;
    expect(body).toEqual({ Go: 13, Markdown: 16, Python: 13, Text: 11 });
    const values = Object.values(body);
    expect([...values].sort((a, b) => b - a)).toEqual(values); // size DESC
  });

  it("answers {} for an empty repository (no refs → no stats, upstream shape)", async () => {
    // a repo row with an untouched engine cell
    const service = new RepoService(env.DB);
    const created = await service.create({
      owner: { id: OWNER_ID, usernameLower: OWNER.toLowerCase() },
      name: "empty-langs",
      isPrivate: false,
      status: "ready",
    });
    const res = await fetchRoute(`/repos/${OWNER}/empty-langs/languages`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({});
    void created;
  });

  it("404s a missing repository", async () => {
    const res = await fetchRoute("/repos/archiver/ghost-repo/languages");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ message: "not found", url: `${ORIGIN}/api/swagger` });
  });
});
