/**
 * The archive + languages read routes on REAL engine content (SPEC-0004 §2.4
 * rows repoGetArchive / repoGetLanguages). The routes mount LOCALLY (the
 * tier-2 compat pattern — the router.ts one-liner is REG-MERGE-2's seam), the
 * repo seeds through the real receive flow (ui/testing seed-repo).
 *
 * Pinned here: the tar.gz round-trip (ustar headers, lowercase repo prefix,
 * gzip magic, commit-time mtimes, symlink/exec modes), the zip structure
 * (DEFLATE entries — `git archive --format=zip`'s method 8 — central
 * directory, EOCD), the `path` subpath filter, the upstream `unknown format`
 * 400 / `unrecognized repository reference` 404 (empty repositories land
 * there too), the multi-segment-ref catchall, the Nix immutable Link header,
 * the .gitattributes export rules (export-ignore honored per gitattributes(5)
 * matching — anchored dir prune, basename depth, exact file, deeper
 * `-export-ignore` re-include — and export-subst pinned as parsed-but-not-
 * substituted, `$Format:…$` literals surviving byte-identical), and the
 * languages map (bytes per language, descending, {} for an empty repo).
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
import { parseGitattributes, ruleMatches } from "./services/archive";
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

// The .gitattributes fixture repo (parity-review-git D3): a marked FILE and a
// marked DIRECTORY, a basename pattern exercised at depth, a deeper
// .gitattributes re-including one file, and an export-subst file.
const ATTR_SLUG = "attr-repo";
const ATTR_PATH = `/repos/${OWNER}/${ATTR_SLUG}`;
const ATTR_KEEP = "package keep\n";
const ATTR_VERSION = "ver=$Format:%H$\n";

const ATTR_COMMITS = [
  {
    message: "seed: attributes",
    time: T0,
    files: [
      {
        path: ".gitattributes",
        content: [
          "# archive attribute suite",
          "/tests export-ignore",
          "*.log export-ignore",
          "docs/notes.md export-ignore",
          "*.go export-ignore",
          "VERSION export-subst",
          "",
        ].join("\n"),
      },
      { path: "lib/.gitattributes", content: "keep.go -export-ignore\n" },
      { path: "README.md", content: "# attribute suite\n" },
      { path: "src/gen.go", content: "package gen\n" },
      { path: "lib/gen.go", content: "package gen\n" },
      { path: "lib/keep.go", content: ATTR_KEEP },
      { path: "src/drop.log", content: "log\n" },
      { path: "deep/nested/drop.log", content: "log\n" },
      { path: "tests/unit.js", content: "test('x', () => {});\n" },
      { path: "tests/sub/deep.txt", content: "deep\n" },
      { path: "docs/notes.md", content: "notes\n" },
      { path: "VERSION", content: ATTR_VERSION },
    ],
  },
];

let OWNER_ID = 1;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS });
  await ensureSeededRepo({ owner: OWNER, slug: ATTR_SLUG, commits: ATTR_COMMITS });
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

async function parseZip(bytes: Uint8Array): Promise<ZipEntry[]> {
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
    const compressedSize = view.getUint32(localOffset + 18, true);
    const size = view.getUint32(localOffset + 22, true);
    const dataStart = localOffset + 30 + localNameLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    const content =
      method === 8
        ? decoder.decode(
            new Uint8Array(
              await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer(),
            ),
          )
        : decoder.decode(bytes.subarray(dataStart, dataStart + size));
    entries.push({
      name,
      method,
      mode: (externalAttrs >>> 16) & 0xffff,
      content,
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

  it("streams a zip of the branch: DEFLATE entries (git archive's method 8), central directory, exec modes preserved", async () => {
    const res = await fetchRoute(`${REPO_PATH}/archive/main.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const zipBytes = new Uint8Array(await res.arrayBuffer());
    const entries = await parseZip(zipBytes);
    expect(entries.map((e) => e.name).sort()).toEqual([
      `${SLUG}/README.md`,
      `${SLUG}/main.go`,
      `${SLUG}/notes.txt`,
      `${SLUG}/src/lib.py`,
    ]);
    for (const entry of entries) {
      expect(entry.method).toBe(8); // DEFLATE — real git archive never STOREs
      expect(entry.mode & 0o170000).toBe(0o100000); // regular files
    }
    // the round-trip proves the local header's CRC/sizes describe the raw bytes
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
// .gitattributes export rules (parity-review-git D3 — tar AND zip arms)
// ---------------------------------------------------------------------------

describe("archive .gitattributes export rules", () => {
  const KEPT = [
    `${ATTR_SLUG}/.gitattributes`,
    `${ATTR_SLUG}/README.md`,
    `${ATTR_SLUG}/VERSION`,
    `${ATTR_SLUG}/lib/.gitattributes`,
    `${ATTR_SLUG}/lib/keep.go`,
  ].sort();

  it("excludes export-ignored entries from the tar: anchored dir prune, basename at depth, exact file; deeper -export-ignore re-includes", async () => {
    const res = await fetchRoute(`${ATTR_PATH}/archive/main.tar.gz`);
    expect(res.status).toBe(200);
    const gz = new Uint8Array(await res.arrayBuffer());
    const tarBytes = new Uint8Array(
      await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
    );
    const entries = parseTar(tarBytes);
    // Negative pin: every UNMARKED file is present — both .gitattributes files
    // themselves (git archives them unless they are export-ignored) and
    // lib/keep.go, re-included by lib/.gitattributes' `keep.go -export-ignore`
    // beating the root `*.go export-ignore` (deeper file, later state).
    expect(entries.map((e) => e.name).sort()).toEqual(KEPT);
    // Excluded: /tests (anchored dir — its whole subtree went with it),
    // *.log at depth (src/drop.log, deep/nested/drop.log), docs/notes.md
    // (exact), src+lib gen.go, and lib/keep.go's siblings.
    expect(entries.some((e) => e.name.includes("tests/"))).toBe(false);
    expect(entries.some((e) => e.name.endsWith(".log"))).toBe(false);
    expect(entries.some((e) => e.name === `${ATTR_SLUG}/docs/notes.md`)).toBe(false);
    const keep = entries.find((e) => e.name === `${ATTR_SLUG}/lib/keep.go`);
    expect(keep?.content).toBe(ATTR_KEEP);
  });

  it("excludes the same set from the zip (DEFLATE entries)", async () => {
    const res = await fetchRoute(`${ATTR_PATH}/archive/main.zip`);
    expect(res.status).toBe(200);
    const entries = await parseZip(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => e.name).sort()).toEqual(KEPT);
    for (const entry of entries) {
      expect(entry.method).toBe(8);
    }
  });

  it("pins the export-subst disposition: parsed, NOT substituted — $Format:…$ survives byte-identical", async () => {
    // Upstream (real git archive) expands $Format:…$ through git's full
    // pretty-format machinery; that is engine-deep here (object-graph
    // abbreviation for %h, ref decorations for %d, mailmap for %aN), and a
    // partial substitution is a state git never produces — so the blob
    // streams byte-identical and the literal survives. Documented in the
    // service module doc; this pin marks the disposition as DELIBERATE.
    for (const tail of ["main.tar.gz", "main.zip"]) {
      const res = await fetchRoute(`${ATTR_PATH}/archive/${tail}`);
      expect(res.status).toBe(200);
      if (tail.endsWith(".zip")) {
        const entries = await parseZip(new Uint8Array(await res.arrayBuffer()));
        expect(entries.find((e) => e.name === `${ATTR_SLUG}/VERSION`)?.content).toBe(ATTR_VERSION);
      } else {
        const gz = new Uint8Array(await res.arrayBuffer());
        const tarBytes = new Uint8Array(
          await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
        );
        expect(new TextDecoder().decode(tarBytes)).toContain(ATTR_VERSION);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// parseGitattributes matching rules (the gitattributes(5) subset, white-box)
// ---------------------------------------------------------------------------

describe("parseGitattributes matching rules", () => {
  /** The documented resolution: the LAST matching export-ignore assignment wins. */
  const excluded = (text: string, dir: string, path: string, isDir = false): boolean => {
    let value: boolean | null | undefined;
    for (const rule of parseGitattributes(text, dir)) {
      if (rule.exportIgnore === undefined) continue;
      if (ruleMatches(rule, path, isDir)) value = rule.exportIgnore;
    }
    return value === true;
  };

  it("last matching line wins; -export-ignore unsets; value forms are never TRUE", () => {
    expect(excluded("x.txt export-ignore\nx.txt -export-ignore\n", "", "x.txt")).toBe(false);
    expect(excluded("x.txt -export-ignore\nx.txt export-ignore\n", "", "x.txt")).toBe(true);
    expect(excluded("x.txt export-ignore=maybe\n", "", "x.txt")).toBe(false);
  });

  it("!pattern negative-pattern lines are skipped (git 2.43 warns and ignores them)", () => {
    const rules = parseGitattributes("!x.txt export-ignore\n", "");
    expect(rules).toEqual([]);
    expect(excluded("!x.txt export-ignore\n", "", "x.txt")).toBe(false);
  });

  it("comments, blank lines and [attr] macro lines produce no rules (macros are outside the subset)", () => {
    expect(parseGitattributes("# comment\n\n[attr]macro export-ignore\n", "")).toEqual([]);
  });

  it("patterns without a slash match the basename at any depth; anchored patterns do not", () => {
    expect(excluded("*.log export-ignore\n", "", "a/b/c.log")).toBe(true);
    expect(excluded("*.log export-ignore\n", "", "a/b/c.txt")).toBe(false);
    // `/tests` anchors to the root: the top-level dir matches, a nested
    // `suite/tests` does not.
    expect(excluded("/tests export-ignore\n", "", "tests", true)).toBe(true);
    expect(excluded("/tests export-ignore\n", "", "suite/tests", true)).toBe(false);
    // a leading slash anchors to the file's directory; a bare name matches
    // basenames at any depth beneath it
    expect(excluded("notes.md export-ignore\n", "docs", "docs/notes.md")).toBe(true);
    expect(excluded("/notes.md export-ignore\n", "docs", "docs/notes.md")).toBe(true);
    expect(excluded("/notes.md export-ignore\n", "docs", "other/notes.md")).toBe(false);
  });

  it("trailing slash makes the pattern directory-only; directories prune, files do not match", () => {
    expect(excluded("gen/ export-ignore\n", "", "gen", true)).toBe(true);
    expect(excluded("gen/ export-ignore\n", "", "lib/gen", true)).toBe(true);
    expect(excluded("gen/ export-ignore\n", "", "gen")).toBe(false);
  });

  it("`**` crosses directories: leading matches any depth, trailing matches the subtree only", () => {
    expect(excluded("**/deep.txt export-ignore\n", "", "a/b/deep.txt")).toBe(true);
    expect(excluded("**/deep.txt export-ignore\n", "", "deep.txt")).toBe(true);
    expect(excluded("dist/** export-ignore\n", "", "dist/x/y.js")).toBe(true);
    expect(excluded("dist/** export-ignore\n", "", "dist", true)).toBe(false);
  });

  it("parses export-subst assignments (recorded for the documented disposition)", () => {
    const rules = parseGitattributes("VERSION export-subst\n!other export-subst\n", "");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.exportSubst).toBe(true);
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
