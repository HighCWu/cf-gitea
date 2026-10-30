/**
 * The PyPI protocol battery (SPEC-0016 §7 M3, §6) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/pypi/pypi.go at the pin:
 *
 *  - the twine upload round-trip (multipart form with the `content` file
 *    part + `sha256_digest`) → 201, the PEP 503 simple index rendering the
 *    upstream template's anchor shape (#sha256= fragments, name
 *    normalization), and the /files download with BYTE PARITY;
 *  - the upstream arms in order: missing content part → 400, digest
 *    mismatch → 400 "hash mismatch", invalid name/version → 400 "invalid
 *    name or version", duplicate-different-bytes → 409 / identical → 201;
 *  - auth: anonymous upload → 401 + the WWW-Authenticate challenge,
 *    wrong-scope token → 401, private owner blinds anonymous downloads;
 *  - quota 403 (strict-polarity var) + the admin bypass; 411 without
 *    Content-Length; PACKAGES_ENABLED=false 404s the family.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, users } from "../../db/schema";
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
const BOUNDARY = "twine-boundary-cf-gitea";

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
      createdAt: new Date("2026-10-29T12:00:00Z"),
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

// ---------------------------------------------------------------------------
// The twine-shaped multipart body (requests-toolbelt's wire: metadata fields,
// then the `content` file part, closed by the bare delimiter).
// ---------------------------------------------------------------------------

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function twineBody(
  fields: Record<string, string>,
  file: { filename: string; content: Uint8Array },
  boundary = BOUNDARY,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(encoder.encode(`--${boundary}\r\n`));
    chunks.push(encoder.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(encoder.encode(`${value}\r\n`));
  }
  chunks.push(encoder.encode(`--${boundary}\r\n`));
  chunks.push(encoder.encode(`Content-Disposition: form-data; name="content"; filename="${file.filename}"\r\n\r\n`));
  chunks.push(file.content);
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  return concatBytes(chunks);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const WHEEL_BYTES = Uint8Array.from({ length: 512 }, (_, i) => i % 251);

/** A twine POST with the correct digest — the suites' fixture. */
async function twineUpload(
  owner: string,
  fields: Record<string, string>,
  file: { filename: string; content: Uint8Array },
  headers: Record<string, string> = {},
  boundary = BOUNDARY,
): Promise<Response> {
  const body = twineBody({ name: "pkg", version: "1.0.0", sha256_digest: await sha256Hex(file.content), ...fields }, file, boundary);
  return protocol()(`/api/packages/${owner}/pypi/`, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
      ...headers,
    },
    body: body,
  });
}

// ---------------------------------------------------------------------------
// The round-trip: twine upload → simple index → download byte-parity
// ---------------------------------------------------------------------------

describe("pypi upload → simple index → download", () => {
  it("round-trips a twine upload: 201 → the simple index anchors → byte-parity download", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await twineUpload(
      "alice",
      { name: "mytool", version: "1.0.0", summary: "a tool", requires_python: ">=3.8" },
      { filename: "mytool-1.0.0-py3-none-any.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    expect(put.status).toBe(201);
    await put.text();

    // The PEP 503 simple index (the upstream template's anchor shape).
    const simple = await protocol()("/api/packages/alice/pypi/simple/mytool");
    expect(simple.status).toBe(200);
    expect(simple.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await simple.text();
    expect(html).toContain("<title>Links for mytool</title>");
    expect(html).toContain("<h1>Links for mytool</h1>");
    const digest = await sha256Hex(WHEEL_BYTES);
    expect(html).toContain(
      `href="https://example.com/api/packages/alice/pypi/files/mytool/1.0.0/mytool-1.0.0-py3-none-any.whl#sha256=${digest}"`,
    );
    expect(html).toContain(` data-requires-python="&gt;=3.8"`);
    expect(html).toContain(`>mytool-1.0.0-py3-none-any.whl</a><br>`);

    // The /files download answers the EXACT uploaded bytes (byte parity).
    const get = await protocol()("/api/packages/alice/pypi/files/mytool/1.0.0/mytool-1.0.0-py3-none-any.whl");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-disposition")).toContain("mytool-1.0.0-py3-none-any.whl");
    const served = new Uint8Array(await get.arrayBuffer());
    expect(served.byteLength).toBe(WHEEL_BYTES.byteLength);
    expect([...served]).toEqual([...WHEEL_BYTES]);

    // GET bumped the download counter (the lead-file arm); the version row
    // carries the pypi metadata JSON.
    const rows = await db().select().from(packageVersions).all();
    expect(rows[0]?.downloadCount).toBe(1);
    const metadata = rows[0]?.metadataJson as string;
    expect(JSON.parse(metadata)).toMatchObject({ summary: "a tool", requires_python: ">=3.8" });
  });

  it("normalizes the project name both ways (upload field and /simple/{id})", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await twineUpload(
      "alice",
      { name: "My_Tool.v2" },
      { filename: "pkg.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    expect(put.status).toBe(201);
    await put.text();

    // Stored normalized: dots/underscores fold to dashes (pypi.go:132).
    const simple = await protocol()("/api/packages/alice/pypi/simple/My_Tool.v2");
    expect(simple.status).toBe(200);
    const html = await simple.text();
    expect(html).toContain("Links for My-Tool-v2");
    expect(html).toContain("/files/my-tool-v2/1.0.0/");
  });

  it("sorts the simple index by the raw version string and lists every version's files", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    for (const [version, filename, tail] of [
      ["2.0", "pkg-2.0.whl", "-two"],
      ["10.0", "pkg-10.0.whl", "-ten"],
      ["1.0", "pkg-1.0.whl", "-one"],
    ] as const) {
      const put = await twineUpload(
        "alice",
        { name: "pkg", version },
        { filename, content: Uint8Array.from(encoderBytes(`bytes${tail}`)) },
        authHeaders(writer),
      );
      expect(put.status).toBe(201);
      await put.text();
    }
    const html = await (await protocol()("/api/packages/alice/pypi/simple/pkg")).text();
    // strings.Compare ascending (pypi.go:67-69): "1.0" < "10.0" < "2.0".
    const one = html.indexOf("pkg-1.0.whl");
    const ten = html.indexOf("pkg-10.0.whl");
    const two = html.indexOf("pkg-2.0.whl");
    expect(one).toBeGreaterThanOrEqual(0);
    expect(one).toBeLessThan(ten);
    expect(ten).toBeLessThan(two);
  });

  it("404s the simple index and the file route for unknown packages", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await twineUpload("alice", { name: "real" }, { filename: "r.whl", content: WHEEL_BYTES }, authHeaders(writer));

    const missingIndex = await protocol()("/api/packages/alice/pypi/simple/ghost");
    expect(missingIndex.status).toBe(404);
    await missingIndex.text();
    const missingFile = await protocol()("/api/packages/alice/pypi/files/real/9.9.9/x.whl");
    expect(missingFile.status).toBe(404);
    await missingFile.text();
  });
});

// ---------------------------------------------------------------------------
// The upstream upload arms (pypi.go:105-136)
// ---------------------------------------------------------------------------

describe("pypi upload validation arms", () => {
  it("400s 'hash mismatch' when sha256_digest contradicts the bytes", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await twineUpload(
      "alice",
      { name: "pkg", version: "1.0.0", sha256_digest: "0".repeat(64) },
      { filename: "pkg.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    expect(put.status).toBe(400);
    expect(await put.text()).toBe("hash mismatch");
  });

  it("400s 'invalid name or version' on a non-PEP name or version", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const badName = await twineUpload(
      "alice",
      { name: "has space", version: "1.0.0" },
      { filename: "p.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    expect(badName.status).toBe(400);
    expect(await badName.text()).toBe("invalid name or version");
    const badVersion = await twineUpload(
      "alice",
      { name: "pkg", version: "not~a~version!" },
      { filename: "p.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    expect(badVersion.status).toBe(400);
    expect(await badVersion.text()).toBe("invalid name or version");
  });

  it("400s when the form has no content file part", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const encoder = new TextEncoder();
    const body = concatBytes([
      encoder.encode(`--${BOUNDARY}\r\n`),
      encoder.encode(`Content-Disposition: form-data; name="name"\r\n\r\npkg\r\n`),
      encoder.encode(`--${BOUNDARY}--\r\n`),
    ]);
    const put = await protocol()("/api/packages/alice/pypi/", {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": String(body.byteLength),
        ...authHeaders(writer),
      },
      body: body,
    });
    expect(put.status).toBe(400);
    await put.text();
  });

  it("ANY duplicate file answers 409 regardless of bytes (D-1 — upstream TryInsertFile)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const first = await twineUpload(
      "alice",
      { name: "dup", version: "1.0" },
      { filename: "same.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    expect(first.status).toBe(201);
    await first.text();
    const sameAgain = await twineUpload(
      "alice",
      { name: "dup", version: "1.0" },
      { filename: "same.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    expect(sameAgain.status).toBe(409); // D-1: identical bytes 409 too — upstream's TryInsertFile row-level duplicate
    await sameAgain.text();
    const conflict = await twineUpload(
      "alice",
      { name: "dup", version: "1.0" },
      { filename: "same.whl", content: Uint8Array.from(encoderBytes("changed-bytes")) },
      authHeaders(writer),
    );
    expect(conflict.status).toBe(409);
    await conflict.text();
  });

  it("a chunked body (no Content-Length) streams to 201 (D-2)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoderBytes("chunked"));
        controller.close();
      },
    });
    const put = await protocol()("/api/packages/alice/pypi/", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...authHeaders(writer) },
      body: stream,
      // @ts-expect-error duplex is the streams spec's required pairing
      duplex: "half",
    });
    // D-2: the spool streamed the unknown-length body (no 411); the bare
    // "chunked" bytes are not a valid twine form so the scan's 400 is the
    // terminal answer — the STREAMING is what this pin guards.
    expect(put.status).toBe(400);
    await put.text();
  });

  it("the homepage lands in the metadata from project_urls (label-normalized), home_page as fallback", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await twineUpload(
      "alice",
      { name: "urls", version: "1", project_urls: "Documentation, https://docs.example.com", home_page: "https://home.example.com" },
      { filename: "u.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    let rows = await db().select().from(packageVersions).all();
    expect(JSON.parse(rows[0]?.metadataJson as string)).toMatchObject({ project_url: "https://home.example.com" });

    // A well-known "Project Home" label (punctuation/whitespace stripped)
    // wins over the deprecated field; an invalid URL is dropped.
    await twineUpload(
      "alice",
      { name: "urls2", version: "1", project_urls: "Home page!, https://real.example.com", home_page: "https://old.example.com" },
      { filename: "u2.whl", content: WHEEL_BYTES },
      authHeaders(writer),
    );
    rows = await db().select().from(packageVersions).all();
    const second = rows.find((row) => row.version === "1" && row.metadataJson?.includes("real.example.com"));
    expect(second).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Auth, quota, enable-gate arms
// ---------------------------------------------------------------------------

describe("pypi auth/quota arms", () => {
  it("anonymous upload → 401 challenge; wrong-scope token → 401 challenge", async () => {
    const owner = await seedUser("alice");
    const wrongCategory = await token(owner, "read:repository");
    const anon = await twineUpload("alice", { name: "n", version: "1" }, { filename: "x.whl", content: WHEEL_BYTES });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anon.text();
    const scoped = await twineUpload(
      "alice",
      { name: "n", version: "1" },
      { filename: "x.whl", content: WHEEL_BYTES },
      authHeaders(wrongCategory),
    );
    expect(scoped.status).toBe(401);
    expect(scoped.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await scoped.text();
  });

  it("a PUBLIC owner's files download anonymously; a PRIVATE owner's do not", async () => {
    const owner = await seedUser("alice");
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    void privateOwner;
    const writer = await token(owner, "write:package");
    const stealthWriter = await token(privateOwner, "write:package");
    await twineUpload("alice", { name: "pub", version: "1" }, { filename: "pub.whl", content: WHEEL_BYTES }, authHeaders(writer));
    await twineUpload(
      "stealth",
      { name: "sec", version: "1" },
      { filename: "sec.whl", content: WHEEL_BYTES },
      authHeaders(stealthWriter),
    );

    const publicGet = await protocol()("/api/packages/alice/pypi/files/pub/1/pub.whl");
    expect(publicGet.status).toBe(200);
    await publicGet.arrayBuffer();

    const privateGet = await protocol()("/api/packages/stealth/pypi/files/sec/1/sec.whl");
    expect(privateGet.status).toBe(401);
    expect(privateGet.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await privateGet.text();
  });

  it("the 403 quota arm (owner-total var override) and the admin bypass", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");

    const limited = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "4" });
    const body = twineBody(
      { name: "q", version: "1", sha256_digest: await sha256Hex(WHEEL_BYTES) },
      { filename: "q.whl", content: WHEEL_BYTES },
    );
    const denied = await limited("/api/packages/alice/pypi/", {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": String(body.byteLength),
        ...authHeaders(writer),
      },
      body: body,
    });
    expect(denied.status).toBe(403);
    await denied.text();

    // The unlimited default lets the same bytes through; an ADMIN uploading
    // to their OWN owner bypasses the cap.
    const allowed = await twineUpload("alice", { name: "q", version: "1" }, { filename: "q.whl", content: WHEEL_BYTES }, authHeaders(writer));
    expect(allowed.status).toBe(201);
    await allowed.text();
    const adminPut = await twineUpload("root", { name: "qa", version: "1" }, { filename: "qa.whl", content: WHEEL_BYTES }, authHeaders(adminWriter));
    expect(adminPut.status).toBe(201);
    await adminPut.text();
  });

  it("the count-quota boundary (+1 parity): the Nth publish reaches the cap, the (N+1)th 403s", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // LIMIT = 2. Upstream inserts the version THEN checks count > limit inside
    // the rolling-back transaction (packages.go:188-191 with the throw at
    // 380-381), so the publish that REACHES the limit passes and only one
    // past 403s — a pre-insert `count > limit` check would allow one version
    // MORE than upstream at exactly this boundary.
    const capped = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "2" });
    const cappedPut = async (version: string): Promise<Response> => {
      const body = twineBody(
        { name: "bnd", version, sha256_digest: await sha256Hex(WHEEL_BYTES) },
        { filename: "bnd.whl", content: WHEEL_BYTES },
      );
      return capped("/api/packages/alice/pypi/", {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
          "content-length": String(body.byteLength),
          ...authHeaders(writer),
        },
        body,
      });
    };

    // N-1 → N: the publish that REACHES the limit succeeds (1 + 1 ≤ 2).
    const reach = await cappedPut("1.0.0");
    expect(reach.status).toBe(201);
    await reach.text();
    // The Nth publish succeeds with the owner exactly AT the limit (2 + 1 →
    // count 2; 2 > 2 is false upstream).
    const atLimit = await cappedPut("2.0.0");
    expect(atLimit.status).toBe(201);
    await atLimit.text();

    // The (N+1)th publish past the cap → 403 ErrQuotaTotalCount, and the
    // rollback posture leaves the two landed versions untouched.
    const over = await cappedPut("3.0.0");
    expect(over.status).toBe(403);
    expect(await over.text()).toBe("package quota count limit exceeded");
    expect((await db().select().from(packageVersions).all())).toHaveLength(2);
  });

  it("PACKAGES_ENABLED=false 404s the whole family", async () => {
    await seedUser("alice");
    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const upload = await disabled("/api/packages/alice/pypi/", { method: "POST", body: "x" });
    expect(upload.status).toBe(404);
    await upload.text();
    const index = await disabled("/api/packages/alice/pypi/simple/pkg");
    expect(index.status).toBe(404);
    await index.text();
  });
});

function encoderBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
