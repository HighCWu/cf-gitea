/**
 * The Maven protocol battery (SPEC-0016 §7 M5, §6) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/maven/maven.go + api.go
 * + modules/packages/maven/metadata.go at the pin. The routes live in the
 * packages-protocols.ts MOUNT BLOCK (a sibling unit owns that file right now),
 * so this suite spins a LOCAL Hono app importing ONLY maven.ts — the local
 * router below is the mount block verbatim, except the gate helpers it
 * re-implements (packages-protocols.ts's private credential pass, already
 * proven by the pypi/helm suites).
 *
 * Pinned from upstream's own integration test (tests/integration/
 * api_packages_maven_test.go):
 *  - the jar round-trip: 201 → duplicate 409 (EVEN identical bytes) → the
 *    artifact-level maven-metadata.xml PUT ignored with 200 → the jar served
 *    with byte parity, content-type application/java-archive, no counter bump
 *    (the jar is not the lead file — the pom is);
 *  - the checksum PUTs verify (wrong sha1 → 400 "hash mismatch", right → 200)
 *    and the .md5 verify works through the local MD5 (WebCrypto has none);
 *  - the checksum GETs serve the STORED blob hashes — for the "test" body the
 *    four upstream vectors (md5 098f6bcd…, sha1 a94a8fe5…, sha256 9f86d081…,
 *    sha512 ee26b0dd…);
 *  - the pom upload parses the coordinates into the version metadata (the
 *    EXISTING-version arm), lands IsLead, and its GET bumps the counter;
 *  - the group maven-metadata.xml renders upstream's EXACT document (the
 *    integration test pins the string AND its four checksums — md5
 *    6bee0cebaaa686d658adf3e7e16371a0 … — which pin this module's XML builder
 *    and MD5 byte-for-byte);
 *  - the SNAPSHOT arm: version-level maven-metadata.xml uploads WITH
 *    OverwriteExisting (201 on a different-bytes re-publish), the release
 *    line skips -SNAPSHOT versions, `latest` does not;
 *  - the legacy arm: `use_legacy_package_name=1` saves "GroupID-ArtifactID",
 *    the next normal upload RENAMES the row to "GroupID:ArtifactID", the
 *    metadata aggregate merges both names (legacy first) and the file GET
 *    falls back to the legacy name;
 *  - auth (401 + the WWW-Authenticate challenge on the write arms and on a
 *    private owner's reads; anonymous reads of a public owner), quota 403
 *    (checksum PUTs stay quota-free, upstream's arm order), the 129-byte
 *    checksum cap → 413, 411 without Content-Length, PACKAGES_ENABLED=false.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageBlobs, packageFiles, packageVersions, packages, userRedirects, users } from "../../db/schema";
import {
  MavenChecksumTooLargeError,
  MavenHashMismatchError,
  MavenInvalidParametersError,
  MavenPackageFileNotExistError,
  MavenPackageNotExistError,
  MavenPomInvalidArgumentError,
  MavenPomParseError,
  Md5,
  decodeMavenPathWildcard,
  extractMavenPathParameters,
  loadMavenMetadataDocument,
  mavenMetadataChecksum,
  md5Hex,
  mavenInternalPackageName,
  mavenLegacyPackageName,
  mavenPathExt,
  openMavenFile,
  parsePomMetadata,
  renderMavenMetadataXml,
  uploadMavenPackageFile,
} from "./maven";
import { QuotaTotalSizeError } from "./model";
import { PackageBlobTooLargeError, PackageSizeMismatchError } from "./blobs";
import { DuplicatePackageFileError } from "./generic";
import { serveFileHeaderSet, servePackageFileResponse } from "./serve-content";
import type { AuthUser } from "../../auth/auth-context";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "../../auth/httpauth";
import { ScopeSet } from "../../auth/scopes";
import { TokenService } from "../../auth/token-service";
import {
  QuotaTotalCountError,
  QuotaTypeSizeError,
  accessModeAtLeast,
  determinePackageAccessMode,
  packagesQuotaFromEnv,
} from "./model";
import { findUserByName, type UserRow } from "../../api/services/repository";
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
  type: "user";
  visibility: "public" | "limited" | "private";
}

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; visibility?: "public" | "limited" | "private" } = {},
): Promise<SeededUser> {
  const visibility = opts.visibility ?? "public";
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: "user",
      visibility,
      createdAt: new Date("2026-10-29T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, isAdmin: user.isAdmin, type: "user", visibility };
}

async function token(user: SeededUser, scopes: string): Promise<string> {
  return (await mintFor(user.id, `pat-${scopes}`, scopes)).plaintext;
}

const authHeaders = (plaintext: string): Record<string, string> => ({
  Authorization: `token ${plaintext}`,
});

// ---------------------------------------------------------------------------
// The LOCAL maven router — the mount block for routes/packages-protocols.ts,
// minus the private gate helpers it re-implements below.
// ---------------------------------------------------------------------------

const WWW_AUTHENTICATE = 'Basic realm="Gitea Package API"';

interface ResolvedCredential {
  doer: AuthUser | null;
  scope: ScopeSet | null;
}

async function resolveCredential(d1: D1Database, request: Request): Promise<ResolvedCredential> {
  const header = request.headers.get("Authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  const credential =
    parsed?.bearerToken?.token ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);
  if (parsed === null || credential === null) {
    return { doer: null, scope: null };
  }
  const verified = await new TokenService(d1).verify(credential, { now: new Date() });
  if (verified === null) {
    return { doer: null, scope: null };
  }
  return { doer: verified.user, scope: ScopeSet.parseLenient(verified.token.scopes) };
}

async function resolveOwnerRow(d1: D1Database, username: string): Promise<UserRow | null> {
  let row = await findUserByName(d1, username);
  if (row === null) {
    const redirect = await drizzle(d1)
      .select({ redirectUserId: userRedirects.redirectUserId })
      .from(userRedirects)
      .where(eq(userRedirects.lowerName, username.toLowerCase()))
      .get();
    if (redirect !== undefined) {
      row = (await drizzle(d1).select().from(users).where(eq(users.id, redirect.redirectUserId)).get()) ?? null;
    }
  }
  return row;
}

async function protocolContext(
  c: Context<{ Bindings: Env }>,
  required: "read" | "write",
): Promise<{ owner: UserRow; cred: ResolvedCredential }> {
  if (!packagesQuotaFromEnv(c.env).packagesEnabled) {
    throw new HTTPException(404, { res: mavenText(404, "not found") });
  }
  const cred = await resolveCredential(c.env.DB, c.req.raw);
  const username = c.req.param("username") ?? "";
  const owner = await resolveOwnerRow(c.env.DB, username);
  if (owner === null) {
    throw new HTTPException(404, { res: mavenText(404, "user does not exist") });
  }
  const ownerVisibleToDoer = cred.doer === null ? owner.visibility === "public" : true;
  const mode = await determinePackageAccessMode(c.env.DB, owner, cred.doer, { ownerVisibleToDoer });
  if ((cred.scope !== null && !cred.scope.has(`${required}:package`)) || !accessModeAtLeast(mode, required)) {
    throw new HTTPException(401, {
      res: mavenText(401, "user should have specific permission or be a site admin", {
        "WWW-Authenticate": WWW_AUTHENTICATE,
      }),
    });
  }
  return { owner, cred };
}

type ContentfulStatus = 200 | 400 | 401 | 403 | 404 | 409 | 411 | 413 | 500;

/** maven.go:52-56 — apiError is ctx.PlainText (maven clients never surface it). */
function mavenText(status: ContentfulStatus, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", ...(extraHeaders ?? {}) },
  });
}

function quotaMessage(error: unknown): string {
  return error instanceof Error ? error.message : "quota exceeded";
}

function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function bodyStream(request: Request): ReadableStream<Uint8Array> {
  return (request.body as ReadableStream<Uint8Array> | null) ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
}

/** The upstream error-body strings, pinned at maven.go's apiError arms. */
function mavenErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (error instanceof MavenInvalidParametersError) return mavenText(400, error.message);
  if (error instanceof MavenPomParseError || error instanceof MavenPomInvalidArgumentError) {
    return mavenText(400, error.message);
  }
  if (error instanceof PackageSizeMismatchError) return mavenText(400, error.message);
  if (error instanceof MavenHashMismatchError) return mavenText(400, error.message);
  if (error instanceof MavenPackageNotExistError) return mavenText(404, error.message);
  if (error instanceof MavenPackageFileNotExistError) return mavenText(404, error.message);
  if (error instanceof MavenChecksumTooLargeError) return mavenText(413, error.message);
  if (error instanceof PackageBlobTooLargeError) return mavenText(413, error.message);
  if (
    error instanceof QuotaTotalCountError ||
    error instanceof QuotaTypeSizeError ||
    error instanceof QuotaTotalSizeError
  ) {
    return mavenText(403, quotaMessage(error));
  }
  if (error instanceof DuplicatePackageFileError) return mavenText(409, "package file already exists");
  console.error("[packages-maven] request failed", error);
  return mavenText(500, "internal server error");
}

function createLocalMavenRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // api.go:337 — r.Put("/*", reqPackageAccess(write), maven.UploadPackageFile)
  app.put("/:username/maven/*", async (c) => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return mavenText(401, "user should have specific permission or be a site admin", {
          "WWW-Authenticate": WWW_AUTHENTICATE,
        });
      }
      const declaredLength = contentLength(c.req.raw);
      if (declaredLength === null) {
        return mavenText(411, "Content-Length header is required");
      }
      const wildcard = decodeMavenPathWildcard(c.req.path, c.req.param("username") ?? "");
      if (wildcard === null) return mavenText(400, "request parameters are invalid");
      const outcome = await uploadMavenPackageFile({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        pathWildcard: wildcard,
        useLegacyPackageName: new URL(c.req.url).searchParams.get("use_legacy_package_name") ?? "",
        content: bodyStream(c.req.raw),
        declaredLength,
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(null, { status: outcome.kind === "created" ? 201 : 200 });
    } catch (error) {
      return mavenErrorResponse(error);
    }
  });

  // api.go:338-339 — r.Get("/*", …DownloadPackageFile) + r.Head("/*", …ProvidePackageFileHeader)
  const mavenDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const wildcard = decodeMavenPathWildcard(c.req.path, c.req.param("username") ?? "");
      if (wildcard === null) return mavenText(400, "request parameters are invalid");
      const params = extractMavenPathParameters(wildcard);
      if (params === null) return mavenText(400, "request parameters are invalid");

      if (params.isMeta && params.version === "") {
        // serveMavenMetadata (maven.go:82-150).
        const doc = await loadMavenMetadataDocument(c.env.DB, owner, params);
        if (doc === null) return mavenText(404, "package does not exist");
        const ext = mavenPathExt(params.filename).toLowerCase();
        const bytes = new TextEncoder().encode(doc.xml);
        if (ext === ".md5" || ext === ".sha1" || ext === ".sha256" || ext === ".sha512") {
          return mavenText(200, await mavenMetadataChecksum(doc.xml, ext));
        }
        const headers = new Headers({
          "content-type": "text/xml",
          "content-length": String(bytes.byteLength),
          "last-modified": doc.lastModified.toUTCString(),
        });
        return new Response(c.req.method === "HEAD" ? null : bytes, { status: 200, headers });
      }

      const opened = await openMavenFile(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        params,
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (opened.kind === "checksum") {
        return mavenText(200, opened.hash);
      }
      // Upstream's HEAD-only branch runs SetServeHeaders WITHOUT the filename
      // (maven.go:216-219) — the D-6 header set but no Content-Disposition
      // and no byte-serving (http.ServeContent never runs there; always 200).
      // The GET arm is helper.ServePackageFile → ctx.ServeContent: the full
      // disposition + the 304/206 arms (review D-6).
      const serveOpts = {
        size: opened.size,
        created: opened.file.createdUnix,
        contentType: opened.contentType,
      };
      if (c.req.method === "HEAD") {
        return new Response(null, { status: 200, headers: serveFileHeaderSet(serveOpts) });
      }
      return servePackageFileResponse(c.req.raw, opened.stream, { ...serveOpts, filename: opened.file.name });
    } catch (error) {
      return mavenErrorResponse(error);
    }
  };
  app.get("/:username/maven/*", (c) => mavenDownload(c));
  app.on("HEAD", "/:username/maven/*", (c) => mavenDownload(c));

  return app;
}

/** The REAL mount shape: index.ts mounts the sub-app at /api/packages. */
function protocol(overrides: Record<string, string> = {}) {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createLocalMavenRouter());
  const boundEnv = { ...env, ...overrides };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
}

const MAVEN_PUT = (body: Uint8Array, headers: Record<string, string>): RequestInit => ({
  method: "PUT",
  headers: { "content-length": String(body.byteLength), ...headers },
  body,
});

const encoder = new TextEncoder();
const TEST_BODY = encoder.encode("test");

// The four upstream checksum vectors for the "test" body
// (api_packages_maven_test.go:246-250).
const TEST_BODY_CHECKSUMS = {
  md5: "098f6bcd4621d373cade4e832627b4f6",
  sha1: "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  sha512:
    "ee26b0dd4af7e749aa1a8ee3c10ae9923f618980772e473f8819a5d4940e0db27ac185f8a0e1d5f84f88bc887fd67b143732c304cc5fa9ad8e6f57f50028a8ff",
} as const;

// The EXACT upstream metadata document + its four checksum vectors
// (api_packages_maven_test.go:265-281).
const UPSTREAM_METADATA_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<metadata><groupId>com.gitea</groupId><artifactId>test-project</artifactId>` +
  `<versioning><release>1.0.1</release><latest>1.0.1</latest><versions><version>1.0.1</version></versions></versioning></metadata>`;
const UPSTREAM_METADATA_CHECKSUMS = {
  ".md5": "6bee0cebaaa686d658adf3e7e16371a0",
  ".sha1": "8696abce499fe84d9ea93e5492abe7147e195b6c",
  ".sha256": "3f48322f81c4b2c3bb8649ae1e5c9801476162b520e1c2734ac06b2c06143208",
  ".sha512":
    "cb075aa2e2ef1a83cdc14dd1e08c505b72d633399b39e73a21f00f0deecb39a3e2c79f157c1163f8a3854828750706e0dec3a0f5e4778e91f8ec2cf351a855f2",
} as const;

const UPSTREAM_POM = `<?xml version="1.0"?>
<project xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <groupId>com.gitea</groupId>
  <artifactId>test-project</artifactId>
  <version>1.0.1</version>
  <description>Test Description</description>
</project>`;

// ---------------------------------------------------------------------------
// The local cryptography (MD5) and the path/coordinate parsers
// ---------------------------------------------------------------------------

describe("md5 (the local RFC 1321 implementation)", () => {
  it("answers the RFC 1321 vectors", () => {
    expect(md5Hex(new Uint8Array(0))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(TEST_BODY)).toBe(TEST_BODY_CHECKSUMS.md5);
    expect(md5Hex(encoder.encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(encoder.encode("message digest"))).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex(encoder.encode("abcdefghijklmnopqrstuvwxyz"))).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    expect(md5Hex(encoder.encode("1234567890".repeat(8)))).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("streams incrementally across arbitrary chunk boundaries", () => {
    const long = encoder.encode("a".repeat(200) + "b".repeat(57)); // spans block edges
    const incremental = new Md5().update(long.subarray(0, 1)).update(long.subarray(1, 64)).update(long.subarray(64));
    expect(incremental.hex()).toBe(md5Hex(long));
  });

  it("reproduces the upstream integration test's metadata-document md5", () => {
    expect(md5Hex(encoder.encode(UPSTREAM_METADATA_XML))).toBe(UPSTREAM_METADATA_CHECKSUMS[".md5"]);
  });
});

describe("extractMavenPathParameters (maven.go:443-490)", () => {
  it("parses the four documented layouts", () => {
    expect(extractMavenPathParameters("com/gitea/test-project/1.0.1/any-name.jar")).toEqual({
      groupId: "com.gitea",
      artifactId: "test-project",
      version: "1.0.1",
      filename: "any-name.jar",
      isMeta: false,
    });
    // The artifact-level metadata request: version stays empty.
    expect(extractMavenPathParameters("com/gitea/test-project/maven-metadata.xml")).toMatchObject({
      groupId: "com.gitea",
      artifactId: "test-project",
      version: "",
      isMeta: true,
    });
    expect(extractMavenPathParameters("com/gitea/test-project/maven-metadata.xml.sha1")).toMatchObject({
      isMeta: true,
      version: "",
    });
    // A -SNAPSHOT metadata request KEEPS its version segment.
    expect(extractMavenPathParameters("com/gitea/test-project/1.0.1-SNAPSHOT/maven-metadata.xml")).toMatchObject({
      version: "1.0.1-SNAPSHOT",
      isMeta: true,
    });
    expect(extractMavenPathParameters("com/gitea/test-project/1.0.1-SNAPSHOT/any.jar")).toMatchObject({
      version: "1.0.1-SNAPSHOT",
      isMeta: false,
    });
  });

  it("rejects too-short paths and the illegal character set", () => {
    expect(extractMavenPathParameters("f.jar")).toBeNull();
    expect(extractMavenPathParameters("proj/f.jar")).toBeNull();
    expect(extractMavenPathParameters("com/gitea/test-proj*ect/1.0/f.jar")).toBeNull();
    expect(extractMavenPathParameters("com/gi:tea/test-project/1.0/f.jar")).toBeNull();
    expect(extractMavenPathParameters("com/gitea/test-project/1.0?/f.jar")).toBeNull();
  });

  it("extends like Go's path.Ext", () => {
    expect(mavenPathExt(".sha1")).toBe(".sha1");
    expect(mavenPathExt("any-name.jar")).toBe(".jar");
    expect(mavenPathExt("a.b.jar")).toBe(".jar");
    expect(mavenPathExt("noext")).toBe("");
  });

  it("slices the route wildcard off the raw path and decodes it", () => {
    expect(decodeMavenPathWildcard("/alice/maven/com/gitea/x/1.0/f%20g.jar", "alice")).toBe(
      "com/gitea/x/1.0/f g.jar",
    );
    // The sub-app sees the FULL mount path — the marker is found anywhere.
    expect(
      decodeMavenPathWildcard("/api/packages/alice/maven/com/gitea/x/1.0/f.jar", "alice"),
    ).toBe("com/gitea/x/1.0/f.jar");
    expect(decodeMavenPathWildcard("/alice/maven/com/gitea/x/1.0/f.jar", "bob")).toBe("");
    expect(decodeMavenPathWildcard("/alice/maven/com/gitea/%zz.jar", "alice")).toBeNull();
    expect(mavenInternalPackageName(extractMavenPathParameters("com/gitea/x/1.0/f.jar")!)).toBe("com.gitea:x");
    expect(mavenLegacyPackageName(extractMavenPathParameters("com/gitea/x/1.0/f.jar")!)).toBe("com.gitea-x");
  });
});

describe("parsePomMetadata (modules/packages/maven/metadata.go)", () => {
  it("extracts the coordinates, description, licenses and dependencies", () => {
    const pom = `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>2.0.0</version>
  <name>Demo Library</name>
  <description>A demo</description>
  <url>https://example.com/demo</url>
  <licenses><license><name>MIT</name><url>https://opensource.org/licenses/MIT</url></license><license><name></name></license></licenses>
  <dependencies>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
    <dependency><groupId>org.yaml</groupId><artifactId>snakeyaml</artifactId></dependency>
  </dependencies>
</project>`;
    const metadata = parsePomMetadata(encoder.encode(pom));
    // The upstream json tag order (metadata.go:17-25).
    expect(JSON.stringify(metadata)).toBe(
      JSON.stringify({
        group_id: "com.example",
        artifact_id: "demo",
        name: "Demo Library",
        description: "A demo",
        project_url: "https://example.com/demo",
        licenses: ["MIT"],
        dependencies: [
          { group_id: "junit", artifact_id: "junit", version: "4.13.2" },
          { group_id: "org.yaml", artifact_id: "snakeyaml" },
        ],
      }),
    );
  });

  it("inherits groupId from the parent block (metadata.go:94-101)", () => {
    const pom = `<project><parent><groupId>org.sonatype.oss</groupId><artifactId>oss-parent</artifactId><version>9</version></parent><artifactId>demo</artifactId></project>`;
    expect(parsePomMetadata(encoder.encode(pom)).group_id).toBe("org.sonatype.oss");
  });

  it("answers 'invalid argument' when neither pom nor parent carries a groupId", () => {
    const pom = `<project><artifactId>demo</artifactId></project>`;
    expect(() => parsePomMetadata(encoder.encode(pom))).toThrow(MavenPomInvalidArgumentError);
  });

  it("rejects a non-project root, malformed XML and unknown entities", () => {
    expect(() => parsePomMetadata(encoder.encode("<wrapper/>"))).toThrow(MavenPomParseError);
    expect(() => parsePomMetadata(encoder.encode("<project><groupId>a</groupId>"))).toThrow(MavenPomParseError);
    expect(() => parsePomMetadata(encoder.encode("<project></other></project>"))).toThrow(MavenPomParseError);
    expect(() => parsePomMetadata(encoder.encode("<project>&unknown;</project>"))).toThrow(MavenPomParseError);
  });

  it("is namespace-tolerant, honors numeric entities, and drops invalid urls", () => {
    const pom = `<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <groupId>com.&amp;x</groupId>
  <artifactId>demo</artifactId>
  <url>ftp://not-a-web-url</url>
</project>`;
    const metadata = parsePomMetadata(encoder.encode(pom));
    expect(metadata.group_id).toBe("com.&x");
    expect(metadata.project_url).toBeUndefined();
  });

  it("keeps the LAST scalar when an element repeats (Go's decode rule)", () => {
    const pom = `<project><groupId>g</groupId><artifactId>a</artifactId><name>first</name><name>second</name></project>`;
    expect(parsePomMetadata(encoder.encode(pom)).name).toBe("second");
  });
});

describe("renderMavenMetadataXml (api.go MetadataResponse)", () => {
  it("renders the exact upstream document", () => {
    expect(renderMavenMetadataXml("com.gitea", "test-project", ["1.0.1"])).toBe(UPSTREAM_METADATA_XML);
  });

  it("omits release when every version is a -SNAPSHOT (omitempty)", () => {
    const xml = renderMavenMetadataXml("g", "a", ["1.0-SNAPSHOT", "0.9-SNAPSHOT"]);
    expect(xml).toContain("<latest>0.9-SNAPSHOT</latest>");
    expect(xml).not.toContain("<release>");
    expect(xml).toContain("<versions><version>1.0-SNAPSHOT</version><version>0.9-SNAPSHOT</version></versions>");
  });

  it("escapes with Go encoding/xml's set", () => {
    const xml = renderMavenMetadataXml("g", "a", [`1.0&'x`]);
    expect(xml).toContain("<release>1.0&amp;&#39;x</release>");
  });
});

// ---------------------------------------------------------------------------
// The upstream integration-test battery, over the local router
// ---------------------------------------------------------------------------

describe("maven upload → checksums → metadata → download", () => {
  it("round-trips a jar: 201 → 409 on the identical duplicate → metadata PUT ignored", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const auth = authHeaders(writer);

    const put = await protocol()(`/api/packages/alice/maven/com/gitea/test-project/1.0.1/any-name.jar`, MAVEN_PUT(TEST_BODY, auth));
    expect(put.status).toBe(201);
    await put.text();
    // Upstream pins the Conflict EVEN for identical bytes (the integration
    // test uploads "test" twice and asserts 409 — maven.go:403-404).
    const duplicate = await protocol()(`/api/packages/alice/maven/com/gitea/test-project/1.0.1/any-name.jar`, MAVEN_PUT(TEST_BODY, auth));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toBe("package file already exists");

    const metaIgnore = await protocol()(`/api/packages/alice/maven/com/gitea/test-project/maven-metadata.xml`, MAVEN_PUT(TEST_BODY, auth));
    expect(metaIgnore.status).toBe(200);
    expect(await metaIgnore.text()).toBe("");

    const pkgRows = await db().select().from(packages).all();
    expect(pkgRows).toHaveLength(1);
    expect(pkgRows[0]?.name).toBe("com.gitea:test-project");
    expect(pkgRows[0]?.semverCompatible).toBe(false);

    const versionRows = await db().select().from(packageVersions).all();
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.version).toBe("1.0.1");

    const fileRows = await db().select().from(packageFiles).all();
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]?.name).toBe("any-name.jar");
    expect(fileRows[0]?.isLead).toBe(false);

    const blobRows = await db().select().from(packageBlobs).all();
    expect(blobRows).toHaveLength(1);
    expect(blobRows[0]?.size).toBe(4);
    // The local MD5 filled the row in (the .md5 wire parity repair).
    expect(blobRows[0]?.hashMd5).toBe(TEST_BODY_CHECKSUMS.md5);
  });

  it("HEAD/GET serve the jar with byte parity, java-archive type, no counter bump", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const url = `/api/packages/alice/maven/com/gitea/test-project/1.0.1/any-name.jar`;
    expect((await protocol()(url, MAVEN_PUT(TEST_BODY, authHeaders(writer)))).status).toBe(201);

    const head = await protocol()(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/java-archive");
    expect(head.headers.get("content-length")).toBe("4");
    expect(head.headers.get("last-modified")).not.toBe("");
    expect(head.headers.get("content-disposition")).toBeNull();
    // The D-6 set rides the HEAD-only branch too — but NOT Accept-Ranges
    // (http.ServeContent never runs on maven HEAD, maven.go:216-219).
    expect(head.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(head.headers.get("accept-ranges")).toBeNull();
    await head.arrayBuffer();

    const get = await protocol()(url);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/java-archive");
    expect(get.headers.get("content-disposition")).toBe("attachment; filename=any-name.jar");
    expect(get.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(get.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([...TEST_BODY]);

    // The jar is NOT the lead file — no download counted.
    const versionRows = await db().select().from(packageVersions).all();
    expect(versionRows[0]?.downloadCount).toBe(0);
  });

  it("serves a unicode-named file with the RFC 5987 filename* twin and the 304 arm (D-6)", async () => {
    // The maven grammar only bars [\\/:"<>|?*] (maven.go:49), so the
    // disposition encoder's non-ASCII arm is reachable on a real upload —
    // the filename arrives URL-decoded off the path wildcard.
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const putUrl = `/api/packages/alice/maven/com/ex/ample/1.0/nü-1.0.pkg`;
    const put = await protocol()(putUrl, MAVEN_PUT(TEST_BODY, authHeaders(writer)));
    expect(put.status).toBe(201);
    await put.arrayBuffer();

    const url = `/api/packages/alice/maven/com/ex/ample/1.0/${encodeURIComponent("nü-1.0.pkg")}`;
    const get = await protocol()(url);
    expect(get.status).toBe(200);
    // content_disposition.go:47-67 — the safe name (ü → _) plus the
    // pct-encoded utf-8 twin of the original (uppercase hex).
    expect(get.headers.get("content-disposition")).toBe(
      "attachment; filename=n_-1.0.pkg; filename*=utf-8''n%C3%BC-1.0.pkg",
    );
    expect(get.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(get.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(get.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([...TEST_BODY]);

    const conditional = await protocol()(url, { headers: { "If-None-Match": "*" } });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("content-disposition")).toBe(
      "attachment; filename=n_-1.0.pkg; filename*=utf-8''n%C3%BC-1.0.pkg",
    );
    expect(conditional.headers.get("content-type")).toBeNull();
    await conditional.text();
  });

  it("verifies checksum PUTs against the stored hashes (wrong → 400, right → 200)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const auth = authHeaders(writer);
    const root = `/api/packages/alice/maven/com/gitea/test-project/1.0.1`;
    expect((await protocol()(`${root}/any-name.jar`, MAVEN_PUT(TEST_BODY, auth))).status).toBe(201);

    const wrong = await protocol()(`${root}/any-name.jar.sha1`, MAVEN_PUT(TEST_BODY, auth));
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toBe("hash mismatch");

    const right = await protocol()(`${root}/any-name.jar.sha1`, MAVEN_PUT(encoder.encode(TEST_BODY_CHECKSUMS.sha1), auth));
    expect(right.status).toBe(200);
    await right.text();

    // The .md5 verify rides the LOCAL md5 (no WebCrypto MD5 exists).
    const md5Put = await protocol()(`${root}/any-name.jar.md5`, MAVEN_PUT(encoder.encode(TEST_BODY_CHECKSUMS.md5), auth));
    expect(md5Put.status).toBe(200);
    await md5Put.text();

    // A checksum against a missing version → 404 (maven.go:308-312).
    const ghost = await protocol()(`/api/packages/alice/maven/com/gitea/test-project/9.9.9/any-name.jar.sha1`, MAVEN_PUT(TEST_BODY, auth));
    expect(ghost.status).toBe(404);
    expect(await ghost.text()).toBe("package does not exist");
  });

  it("serves the STORED checksums for the 'test' blob (the upstream vectors)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const root = `/api/packages/alice/maven/com/gitea/test-project/1.0.1`;
    expect((await protocol()(`${root}/any-name.jar`, MAVEN_PUT(TEST_BODY, authHeaders(writer)))).status).toBe(201);

    const got: Record<string, string> = {};
    for (const ext of [".md5", ".sha1", ".sha256", ".sha512"]) {
      const res = await protocol()(`${root}/any-name.jar${ext}`);
      expect(res.status).toBe(200);
      got[ext] = await res.text();
    }
    expect(got[".md5"]).toBe(TEST_BODY_CHECKSUMS.md5);
    expect(got[".sha1"]).toBe(TEST_BODY_CHECKSUMS.sha1);
    expect(got[".sha256"]).toBe(TEST_BODY_CHECKSUMS.sha256);
    expect(got[".sha512"]).toBe(TEST_BODY_CHECKSUMS.sha512);
  });

  it("parses the pom on upload (the EXISTING-version arm) and leads the counter", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const auth = authHeaders(writer);
    const root = `/api/packages/alice/maven/com/gitea/test-project`;
    expect((await protocol()(`${root}/1.0.1/any-name.jar`, MAVEN_PUT(TEST_BODY, auth))).status).toBe(201);

    const pomBytes = encoder.encode(UPSTREAM_POM);
    const pomPut = await protocol()(`${root}/1.0.1/any-name.jar.pom`, MAVEN_PUT(pomBytes, auth));
    expect(pomPut.status).toBe(201);
    await pomPut.text();

    const versionRows = await db().select().from(packageVersions).all();
    expect(versionRows).toHaveLength(1);
    expect(JSON.parse(versionRows[0]?.metadataJson as string)).toEqual({
      group_id: "com.gitea",
      artifact_id: "test-project",
      description: "Test Description",
    });

    const fileRows = await db().select().from(packageFiles).all();
    expect(fileRows).toHaveLength(2);
    const pomFile = fileRows.find((row) => row.name === "any-name.jar.pom");
    expect(pomFile?.isLead).toBe(true);

    // The pom GET bumps the counter (IsLead); the pom bytes serve verbatim.
    const get = await protocol()(`${root}/1.0.1/any-name.jar.pom`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/xml");
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([...pomBytes]);
    const afterRows = await db().select().from(packageVersions).all();
    expect(afterRows[0]?.downloadCount).toBe(1);

    // A malformed pom → 400 with the parse error (plain text).
    const bad = await protocol()(`${root}/1.0.1/broken.pom`, MAVEN_PUT(encoder.encode("<project><groupId>x"), auth));
    expect(bad.status).toBe(400);
    await bad.text();
  });

  it("serves the group maven-metadata.xml EXACTLY (document + the four checksum vectors)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const root = `/api/packages/alice/maven/com/gitea/test-project`;
    expect((await protocol()(`${root}/1.0.1/any-name.jar`, MAVEN_PUT(TEST_BODY, authHeaders(writer)))).status).toBe(201);

    const meta = await protocol()(`${root}/maven-metadata.xml`);
    expect(meta.status).toBe(200);
    expect(await meta.text()).toBe(UPSTREAM_METADATA_XML);
    expect(meta.headers.get("content-type")).toBe("text/xml");
    expect(meta.headers.get("content-length")).toBe(String(encoder.encode(UPSTREAM_METADATA_XML).byteLength));
    expect(meta.headers.get("last-modified")).not.toBe("");

    for (const [ext, expected] of Object.entries(UPSTREAM_METADATA_CHECKSUMS)) {
      const res = await protocol()(`${root}/maven-metadata.xml${ext}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(expected);
    }

    // A missing version and a missing file are the two 404 shapes.
    const noVersion = await protocol()(`${root}/1.2.3/any-name.jar`);
    expect(noVersion.status).toBe(404);
    expect(await noVersion.text()).toBe("package does not exist");
    const noFile = await protocol()(`${root}/1.0.1/ghost.jar`);
    expect(noFile.status).toBe(404);
    expect(await noFile.text()).toBe("package file does not exist");
  });

  it("bad path layouts answer 400 'request parameters are invalid'", async () => {
    await seedUser("alice");
    const tooShort = await protocol()(`/api/packages/alice/maven/just-a-file.jar`);
    expect(tooShort.status).toBe(400);
    expect(await tooShort.text()).toBe("request parameters are invalid");
    const illegal = await protocol()(`/api/packages/alice/maven/com/gitea/x/1.0*/f.jar`);
    expect(illegal.status).toBe(400);
    await illegal.text();
  });
});

describe("the SNAPSHOT arm (maven.go:356 OverwriteExisting)", () => {
  it("stores version-level metadata files, re-publishes them, and orders release/latest", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const auth = authHeaders(writer);
    const root = `/api/packages/alice/maven/com/gitea/snap`;

    expect((await protocol()(`${root}/1.0.0/app.jar`, MAVEN_PUT(TEST_BODY, auth))).status).toBe(201);
    expect((await protocol()(`${root}/1.0.1-SNAPSHOT/app.jar`, MAVEN_PUT(TEST_BODY, auth))).status).toBe(201);
    // The artifact-level index is still ignored.
    expect((await protocol()(`${root}/maven-metadata.xml`, MAVEN_PUT(TEST_BODY, auth))).status).toBe(200);

    // The SNAPSHOT's own metadata file: created, then OVERWRITTEN on the
    // different-bytes re-publish (both 201 — upstream pins exactly this).
    const firstMeta = encoder.encode("<snapshot>first</snapshot>");
    expect((await protocol()(`${root}/1.0.1-SNAPSHOT/maven-metadata.xml`, MAVEN_PUT(firstMeta, auth))).status).toBe(201);
    const secondMeta = encoder.encode("<snapshot>second</snapshot>");
    expect((await protocol()(`${root}/1.0.1-SNAPSHOT/maven-metadata.xml`, MAVEN_PUT(secondMeta, auth))).status).toBe(201);

    const served = await protocol()(`${root}/1.0.1-SNAPSHOT/maven-metadata.xml`);
    expect(served.status).toBe(200);
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...secondMeta]);

    // Exactly one stored metadata file for the SNAPSHOT version.
    const versionRows = await db().select().from(packageVersions).all();
    const snapshotVersion = versionRows.find((row) => row.version === "1.0.1-SNAPSHOT");
    const metaFiles = await db()
      .select()
      .from(packageFiles)
      .where(eq(packageFiles.versionId, snapshotVersion?.id ?? -1))
      .all();
    expect(metaFiles).toHaveLength(2); // app.jar + maven-metadata.xml (replaced, not duplicated)

    // release skips -SNAPSHOT; latest follows creation order.
    const doc = await protocol()(`${root}/maven-metadata.xml`);
    const xml = await doc.text();
    expect(xml).toContain("<release>1.0.0</release>");
    expect(xml).toContain("<latest>1.0.1-SNAPSHOT</latest>");
    expect(xml).toContain("<versions><version>1.0.0</version><version>1.0.1-SNAPSHOT</version></versions>");
  });
});

describe("the legacy package-name arm (maven.go:292-303)", () => {
  it("saves under GroupID-ArtifactID, then renames on the next normal upload", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const auth = authHeaders(writer);
    const root = `/api/packages/alice/maven/com/gitea/legacy-project`;

    // Legacy-flagged upload → the package row carries the dash form.
    const legacyPut = await protocol()(`${root}/1.0.2/any-file-name?use_legacy_package_name=1`, MAVEN_PUT(TEST_BODY, auth));
    expect(legacyPut.status).toBe(201);
    await legacyPut.text();
    let pkg = (await db().select().from(packages).all())[0];
    expect(pkg?.name).toBe("com.gitea-legacy-project");

    // The GET falls back to the legacy name.
    const legacyGet = await protocol()(`${root}/1.0.2/any-file-name`);
    expect(legacyGet.status).toBe(200);
    await legacyGet.arrayBuffer();

    // The next NORMAL upload renames the row to the colon form (both
    // versions then aggregate under one package).
    const normalPut = await protocol()(`${root}/1.0.3/any-file-name`, MAVEN_PUT(TEST_BODY, auth));
    expect(normalPut.status).toBe(201);
    await normalPut.text();
    pkg = (await db().select().from(packages).all())[0];
    expect(pkg?.name).toBe("com.gitea:legacy-project");

    const versionRows = await db().select().from(packageVersions).all();
    expect(versionRows).toHaveLength(2);

    // The metadata aggregate merges BOTH names (legacy first).
    const doc = await protocol()(`${root}/maven-metadata.xml`);
    const xml = await doc.text();
    expect(xml).toContain("<version>1.0.2</version>");
    expect(xml).toContain("<version>1.0.3</version>");
    // The old version still serves under the same path after the rename.
    const oldGet = await protocol()(`${root}/1.0.2/any-file-name`);
    expect(oldGet.status).toBe(200);
    await oldGet.arrayBuffer();
  });
});

// ---------------------------------------------------------------------------
// Auth, quota, limits arms (the pypi/helm idiom over maven's plain-text bodies)
// ---------------------------------------------------------------------------

describe("maven auth/quota/limits arms", () => {
  it("anonymous upload → 401 challenge; wrong-scope token → 401 challenge", async () => {
    const owner = await seedUser("alice");
    const wrongCategory = await token(owner, "read:repository");

    const anon = await protocol()(`/api/packages/alice/maven/com/gitea/x/1.0/f.jar`, MAVEN_PUT(TEST_BODY, {}));
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anon.text();

    const scoped = await protocol()(`/api/packages/alice/maven/com/gitea/x/1.0/f.jar`, MAVEN_PUT(TEST_BODY, authHeaders(wrongCategory)));
    expect(scoped.status).toBe(401);
    expect(scoped.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await scoped.text();
  });

  it("a public owner's artifacts read anonymously; a private owner's are the challenge", async () => {
    const owner = await seedUser("alice");
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const writer = await token(owner, "write:package");
    const stealthWriter = await token(privateOwner, "write:package");
    expect(
      (await protocol()(`/api/packages/alice/maven/com/gitea/pub/1.0/f.jar`, MAVEN_PUT(TEST_BODY, authHeaders(writer)))).status,
    ).toBe(201);
    expect(
      (
        await protocol()(`/api/packages/stealth/maven/com/gitea/sec/1.0/f.jar`, MAVEN_PUT(TEST_BODY, authHeaders(stealthWriter)))
      ).status,
    ).toBe(201);

    const publicGet = await protocol()(`/api/packages/alice/maven/com/gitea/pub/1.0/f.jar`);
    expect(publicGet.status).toBe(200);
    await publicGet.arrayBuffer();

    const privateGet = await protocol()(`/api/packages/stealth/maven/com/gitea/sec/1.0/f.jar`);
    expect(privateGet.status).toBe(401);
    expect(privateGet.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await privateGet.text();
  });

  it("the 403 quota arm spares the checksum-verify PUT (upstream's arm order)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const auth = authHeaders(writer);
    const root = `/api/packages/alice/maven/com/gitea/quota`;
    expect((await protocol()(`${root}/1.0/f.jar`, MAVEN_PUT(TEST_BODY, auth))).status).toBe(201);

    const limited = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "4" });
    // A NEW artifact PUT: the owner total (4 bytes) + 4 > 4 → 403.
    const denied = await limited(`${root}/2.0/f.jar`, MAVEN_PUT(TEST_BODY, auth));
    expect(denied.status).toBe(403);
    await denied.text();

    // The checksum PUT stays quota-free (it returns before any quota check,
    // maven.go:305-347).
    const checksum = await limited(`${root}/1.0/f.jar.sha1`, MAVEN_PUT(encoder.encode(TEST_BODY_CHECKSUMS.sha1), auth));
    expect(checksum.status).toBe(200);
    await checksum.text();
  });

  it("the count-quota boundary (+1 parity): the Nth publish reaches the cap, the (N+1)th 403s", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const auth = authHeaders(writer);
    // LIMIT = 2. Upstream inserts the version THEN checks count > limit inside
    // the rolling-back transaction (packages.go:188-191 with the throw at
    // 380-381), so the publish that REACHES the limit passes and only one
    // past 403s — a pre-insert `count > limit` check would allow one version
    // MORE than upstream at exactly this boundary.
    const capped = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "2" });
    const cappedPut = (version: string): Promise<Response> =>
      capped(`/api/packages/alice/maven/com/gitea/bnd/${version}/f.jar`, MAVEN_PUT(TEST_BODY, auth));

    // N-1 → N: the publish that REACHES the limit succeeds (1 + 1 ≤ 2).
    const reach = await cappedPut("1.0");
    expect(reach.status).toBe(201);
    await reach.text();
    // The Nth publish succeeds with the owner exactly AT the limit (2 + 1 →
    // count 2; 2 > 2 is false upstream).
    const atLimit = await cappedPut("2.0");
    expect(atLimit.status).toBe(201);
    await atLimit.text();

    // The (N+1)th publish past the cap → 403 ErrQuotaTotalCount, and the
    // rollback posture leaves the two landed versions untouched.
    const over = await cappedPut("3.0");
    expect(over.status).toBe(403);
    expect(await over.text()).toBe("maximum allowed package count exceeded");
    expect((await db().select().from(packageVersions).all())).toHaveLength(2);
  });

  it("a checksum body over 129 bytes → 413 'checksum is too large'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const root = `/api/packages/alice/maven/com/gitea/big/1.0/f.jar`;
    expect((await protocol()(root, MAVEN_PUT(TEST_BODY, authHeaders(writer)))).status).toBe(201);

    const oversized = encoder.encode("a".repeat(130));
    const res = await protocol()(`${root}.sha1`, MAVEN_PUT(oversized, authHeaders(writer)));
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("checksum is too large");
  });

  it("411 without Content-Length; a short body → 400; PACKAGES_ENABLED=false 404s", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("chunked"));
        controller.close();
      },
    });
    const noLength = await protocol()(`/api/packages/alice/maven/com/gitea/x/1.0/f.jar`, {
      method: "PUT",
      headers: authHeaders(writer),
      body: stream,
      // @ts-expect-error duplex is the streams spec's required pairing
      duplex: "half",
    });
    expect(noLength.status).toBe(411);
    await noLength.text();

    const short = await protocol()(`/api/packages/alice/maven/com/gitea/x/1.0/f.jar`, {
      method: "PUT",
      headers: { "content-length": "100", ...authHeaders(writer) },
      body: encoder.encode("short"),
    });
    expect(short.status).toBe(400);
    await short.text();

    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const gone = await disabled(`/api/packages/alice/maven/com/gitea/x/1.0/f.jar`, MAVEN_PUT(TEST_BODY, authHeaders(writer)));
    expect(gone.status).toBe(404);
    await gone.text();
    const readGone = await disabled(`/api/packages/alice/maven/com/gitea/x/1.0/f.jar`);
    expect(readGone.status).toBe(404);
    await readGone.text();
  });
});

// ---------------------------------------------------------------------------
// The service-level arms the route maps (driven directly — the mount block is
// a sibling's file): quota classes + the duplicate outcome + metadata 404.
// ---------------------------------------------------------------------------

describe("service-level arms (driven directly)", () => {
  it("throws the typed quota/duplicate classes the mount block maps", async () => {
    const owner = await seedUser("alice");
    const doer = { id: owner.id, isAdmin: false };
    const quota = packagesQuotaFromEnv({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "0" });
    const body = () =>
      new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(TEST_BODY); controller.close(); } });
    // Seed ONE version (count 1 > the 0 cap) — upstream checks the count only
    // when a version would be created.
    await uploadMavenPackageFile({
      d1: env.DB,
      bucket: env.REPO_PACKS,
      owner,
      doer,
      pathWildcard: "com/gitea/cap/1.0/f.jar",
      useLegacyPackageName: "",
      content: body(),
      declaredLength: TEST_BODY.byteLength,
      quota: packagesQuotaFromEnv({}),
    });
    await expect(
      uploadMavenPackageFile({
        d1: env.DB,
        bucket: env.REPO_PACKS,
        owner,
        doer,
        pathWildcard: "com/gitea/cap/2.0/f.jar",
        useLegacyPackageName: "",
        content: body(),
        declaredLength: TEST_BODY.byteLength,
        quota,
      }),
    ).rejects.toThrow(QuotaTotalCountError);

    // The identical-bytes re-upload surfaces as DuplicatePackageFileError at
    // the service (the route maps it to 409).
    await expect(
      uploadMavenPackageFile({
        d1: env.DB,
        bucket: env.REPO_PACKS,
        owner,
        doer,
        pathWildcard: "com/gitea/cap/1.0/f.jar",
        useLegacyPackageName: "",
        content: body(),
        declaredLength: TEST_BODY.byteLength,
        quota: packagesQuotaFromEnv({}),
      }),
    ).rejects.toThrow(DuplicatePackageFileError);
  });

  it("loadMavenMetadataDocument answers null for an unknown group/artifact", async () => {
    const owner = await seedUser("alice");
    const params = extractMavenPathParameters("com/gitea/ghost/maven-metadata.xml");
    expect(params).not.toBeNull();
    expect(await loadMavenMetadataDocument(env.DB, owner, params!)).toBeNull();
  });

  it("openMavenFile throws the typed 404s and serves the checksum shape", async () => {
    const owner = await seedUser("alice");
    const doer = { id: owner.id, isAdmin: false };
    await uploadMavenPackageFile({
      d1: env.DB,
      bucket: env.REPO_PACKS,
      owner,
      doer,
      pathWildcard: "com/gitea/serve/1.0/f.jar",
      useLegacyPackageName: "",
      content: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(TEST_BODY); controller.close(); } }),
      declaredLength: TEST_BODY.byteLength,
      quota: packagesQuotaFromEnv({}),
    });
    const checksum = await openMavenFile(
      env.DB,
      env.REPO_PACKS,
      owner,
      extractMavenPathParameters("com/gitea/serve/1.0/f.jar.sha1")!,
      "GET",
    );
    expect(checksum.kind).toBe("checksum");
    expect(checksum.kind === "checksum" && checksum.hash).toBe(TEST_BODY_CHECKSUMS.sha1);

    await expect(
      openMavenFile(env.DB, env.REPO_PACKS, owner, extractMavenPathParameters("com/gitea/serve/9.9/f.jar")!, "GET"),
    ).rejects.toThrow("package does not exist");
    await expect(
      openMavenFile(env.DB, env.REPO_PACKS, owner, extractMavenPathParameters("com/gitea/serve/1.0/ghost.jar")!, "GET"),
    ).rejects.toThrow("package file does not exist");
  });
});
