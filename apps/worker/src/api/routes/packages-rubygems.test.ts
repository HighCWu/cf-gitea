/**
 * The RubyGems protocol battery (SPEC-0016 §7's long-tail `rubygems` row)
 * on real D1 + the real REPO_PACKS binding — upstream
 * routers/api/packages/rubygems/rubygems.go + modules/packages/rubygems/
 * {marshal.go, metadata.go} at the pin fc493688, with the upstream
 * integration test tests/integration/api_packages_rubygems_test.go as the
 * client-shape oracle:
 *
 *  - the Marshal 4.8 encoder's BYTE VECTORS (marshal_test.go's
 *    TestMinimalEncoder table — nil/bool/fixnum/string/array/usermarshal/
 *    userdef/object, the error ranges, the length-form arms);
 *  - the upload round-trip of a HAND-BUILT .gem (the upstream builder
 *    ported: tar{data.tar.gz, metadata.gz, checksums.yaml.gz}, the metadata
 *    the integration test's YAML fixture) → 201, the type "rubygems"
 *    SemverCompatible package + version, the MetadataJSON, the ONE lead
 *    file {name}-{version}.gem, byte-parity download + the counter bump;
 *  - the gemspec.rz oracle: the integration test's EXACT Marshal byte string
 *    after the zlib inflate (the "content is from NewMarshalEncoder" assert);
 *  - the enumerations: the integration test's base64 gzip vectors gunzipped
 *    to the exact Marshal payloads (specs.4.8 / latest_specs.4.8 /
 *    prerelease_specs.4.8);
 *  - the compact index: the integration test's exact info + versions text;
 *  - the parse gates (metadata_test.go): the missing metadata.gz 400, the
 *    invalid-name rows, the newline-forgery rows, the 32 MiB cap;
 *  - the yank walk (multipart DELETE → 200, the non-multipart 500 arm, the
 *    404 message), the auth/quota arms, PACKAGES_ENABLED=false.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageVersions, packages, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import {
  MarshalEncoder,
  RubyMarshalIntRangeError,
  RubyObject,
  RubyUserDef,
  RubyUserMarshal,
  type MarshalValue,
  asVersionRequirement,
  buildRubyGemCompactIndex,
  buildRubyGemEmptySpecsPayload,
  buildRubyGemSpecification,
  buildRubyGemSpecsPayload,
  extractGemMetadataGz,
  listRubyGemVersionsByType,
  makeGemFullFileName,
  parseRubyGemPackage,
} from "../../services/packages/rubygems";
import { base64ToBytes, buildTar, gzipCompress } from "../../services/packages/distro-common";
import { md5Hex } from "../../services/packages/maven";

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

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes.slice()).body?.pipeThrough(new DecompressionStream("gzip"));
  if (!stream) throw new Error("no gzip stream");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes.slice()).body?.pipeThrough(new DecompressionStream("deflate"));
  if (!stream) throw new Error("no zlib stream");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const bytesText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// The .gem builder — the upstream integration test's makeRubyGem ported:
// tar{data.tar.gz, metadata.gz, checksums.yaml.gz} over the gzipped YAML
// gemspec fixture (name/version substituted).
// ---------------------------------------------------------------------------

const GEMSPEC_TEMPLATE = (name: string, version: string): string => `--- !ruby/object:Gem::Specification
name: ${name}
version: !ruby/object:Gem::Version
  version: ${version}
platform: ruby
authors:
- Gitea
autorequire:
bindir: bin
cert_chain: []
date: 2021-08-23 00:00:00.000000000 Z
dependencies:
- !ruby/object:Gem::Dependency
  name: runtime-dep
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: 1.2.0
    - - "<"
      - !ruby/object:Gem::Version
        version: '2.0'
  type: :runtime
  prerelease: false
  version_requirements: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: 1.2.0
    - - "<"
      - !ruby/object:Gem::Version
        version: '2.0'
- !ruby/object:Gem::Dependency
  name: dev-dep
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '5.2'
  type: :development
  prerelease: false
  version_requirements: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '5.2'
description: RubyGems package test
email: rubygems@gitea.io
executables: []
extensions: []
extra_rdoc_files: []
files:
- lib/gitea.rb
homepage: https://gitea.io/
licenses:
- MIT
metadata: {}
post_install_message:
rdoc_options: []
require_paths:
- lib
required_ruby_version: !ruby/object:Gem::Requirement
  requirements:
  - - ">="
    - !ruby/object:Gem::Version
      version: 2.3.0
required_rubygems_version: !ruby/object:Gem::Requirement
  requirements:
  - - ">="
    - !ruby/object:Gem::Version
      version: '1.0'
requirements: []
rubyforge_project:
rubygems_version: 2.7.6.2
signing_key:
specification_version: 4
summary: Gitea package
test_files: []
`;

async function makeRubyGem(
  name: string,
  version: string,
  overrides: { metadataYaml?: string } = {},
): Promise<Uint8Array> {
  const metadataYaml = overrides.metadataYaml ?? GEMSPEC_TEMPLATE(name, version);
  const metadataGz = await gzipCompress(new TextEncoder().encode(metadataYaml));
  const dataTarGz = await gzipCompress(
    buildTar([{ name: "lib/gitea.rb", mode: 0o644, data: new TextEncoder().encode("class Gitea\nend") }], true),
  );
  const checksumsYaml = `---
SHA256:
  metadata.gz: ${await sha256Hex(metadataGz)}
  data.tar.gz: ${await sha256Hex(dataTarGz)}
`;
  return buildTar(
    [
      { name: "data.tar.gz", mode: 0o644, data: dataTarGz },
      { name: "metadata.gz", mode: 0o644, data: metadataGz },
      { name: "checksums.yaml.gz", mode: 0o644, data: await gzipCompress(new TextEncoder().encode(checksumsYaml)) },
    ],
    true,
  );
}

async function uploadGem(owner: string, gem: Uint8Array, auth?: Record<string, string>): Promise<Response> {
  return protocol()(`/api/packages/${owner}/rubygems/api/v1/gems`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...auth },
    body: gem.slice(),
  });
}

async function seedAliceWithGem(
  gemName = "gitea",
  gemVersion = "1.0.5",
): Promise<{ owner: SeededUser; gem: Uint8Array; writer: string }> {
  const owner = await seedUser("alice");
  const writer = await token(owner, "write:package");
  const gem = await makeRubyGem(gemName, gemVersion);
  const put = await uploadGem("alice", gem, authHeaders(writer));
  expect(put.status).toBe(201);
  await put.arrayBuffer();
  return { owner, gem, writer };
}

/** The integration test's base64 gzip vectors (one-gem gitea-1.0.5 store). */
const ENUMERATE_VECTORS: Record<string, string> = {
  "specs.4.8":
    "H4sICAAAAAAA/3NwZWNzLjQuOABi4Yhmi+bwVOJKzyxJTWSzYnMNCbUSdE/NtbIKSy0qzszPi2bzVOIy1DPQM2WzZgjxVOIsKk2qBDEBAQAA///xOEYKOwAAAA==",
  "latest_specs.4.8":
    "H4sICAAAAAAA/2xhdGVzdF9zcGVjcy40LjgAYuGIZovm8FTiSs8sSU1ks2JzDQm1EnRPzbWyCkstKs7Mz4tm81TiMtQz0DNls2YI8VTiLCpNqgQxAQEAAP//8ThGCjsAAAA=",
  "prerelease_specs.4.8": "H4sICAAAAAAA/3ByZXJlbGVhc2Vfc3BlY3MuNC44AGLhiGYABAAA//9snXr5BAAAAA==",
};

// ---------------------------------------------------------------------------
// The Marshal 4.8 encoder — marshal_test.go's TestMinimalEncoder vectors
// ---------------------------------------------------------------------------

describe("MarshalEncoder (the marshal.go port, marshal_test.go vectors)", () => {
  it("pins the exact byte shapes", () => {
    const pairs: { value: MarshalValue; expected: number[] }[] = [
      { value: null, expected: [4, 8, 0x30] },
      { value: true, expected: [4, 8, 0x54] },
      { value: false, expected: [4, 8, 0x46] },
      { value: 0, expected: [4, 8, 0x69, 0] },
      { value: 1, expected: [4, 8, 0x69, 6] },
      { value: -1, expected: [4, 8, 0x69, 0xfa] },
      { value: 0x1fffffff, expected: [4, 8, 0x69, 4, 0xff, 0xff, 0xff, 0x1f] },
      { value: "test", expected: [4, 8, 0x49, 0x22, 9, 116, 101, 115, 116, 6, 0x3a, 6, 0x45, 0x54] },
      { value: [1, 2], expected: [4, 8, 0x5b, 7, 0x69, 6, 0x69, 7] },
      { value: new RubyUserMarshal("Test", 4), expected: [4, 8, 0x55, 0x3a, 9, 84, 101, 115, 116, 0x69, 9] },
      {
        value: new RubyUserDef("Test", 4),
        expected: [4, 8, 0x75, 0x3a, 9, 84, 101, 115, 116, 9, 4, 8, 0x69, 9],
      },
      {
        value: new RubyObject("Test", [["test", 4]]),
        expected: [4, 8, 0x6f, 0x3a, 9, 84, 101, 115, 116, 6, 0x3a, 9, 116, 101, 115, 116, 0x69, 9],
      },
    ];
    for (const { value, expected } of pairs) {
      expect(Array.from(new MarshalEncoder().encode(value)), JSON.stringify(expected)).toEqual(expected);
    }
  });

  it("carries the length-form and negative-length arms the table's boundaries imply", () => {
    expect(Array.from(new MarshalEncoder().encode(123))).toEqual([4, 8, 0x69, 1, 123]);
    expect(Array.from(new MarshalEncoder().encode(256))).toEqual([4, 8, 0x69, 2, 0, 1]);
    expect(Array.from(new MarshalEncoder().encode(-200))).toEqual([4, 8, 0x69, 0xff, 0x38]);
    expect(Array.from(new MarshalEncoder().encode(-1000))).toEqual([4, 8, 0x69, 0xfe, 0x18, 0xfc]);
  });

  it("throws the ErrInvalidIntRange / ErrUnsupportedType sentinels", () => {
    expect(() => new MarshalEncoder().encode(0x41000000)).toThrow(RubyMarshalIntRangeError);
    expect(() => new MarshalEncoder().encode(-0x40000001)).toThrow(RubyMarshalIntRangeError);
    // A bare object literal is outside the encoder's value set (Go's
    // ErrUnsupportedType arm — the anonymous-struct case).
    expect(() => new MarshalEncoder().encode({ nope: true } as unknown as MarshalValue)).toThrow();
  });

  it("dedups symbols across the encoding (the ';'+index links)", () => {
    // Two identical usermarshals: the second Gem::Version symbol is a link
    // (the symbol SPELLS once — ':' + length-prefixed — then ';'+index).
    const bytes = new MarshalEncoder().encode([
      new RubyUserMarshal("Gem::Version", ["1"]),
      new RubyUserMarshal("Gem::Version", ["2"]),
    ]);
    const text = bytesText(bytes);
    expect(text.split("Gem::Version")).toHaveLength(2); // one spelled occurrence
    expect(text.includes(";")).toBe(true); // the second is the ';'-link
  });
});

// ---------------------------------------------------------------------------
// The gem container parse (metadata.go) — the metadata_test.go arms at the
// service seam
// ---------------------------------------------------------------------------

describe("parseRubyGemPackage (the metadata.go port)", () => {
  it("parses the integration fixture: the field set, the dependency split, the requirement rows", async () => {
    const parsed = await parseRubyGemPackage(await makeRubyGem("gitea", "1.0.5"));
    expect(parsed.name).toBe("gitea");
    expect(parsed.version).toBe("1.0.5");
    expect(parsed.metadata.platform).toBe("ruby");
    expect(parsed.metadata.summary).toBe("Gitea package");
    expect(parsed.metadata.description).toBe("RubyGems package test");
    expect(parsed.metadata.authors).toEqual(["Gitea"]);
    expect(parsed.metadata.projectUrl).toBe("https://gitea.io/");
    expect(parsed.metadata.licenses).toEqual(["MIT"]);
    expect(parsed.metadata.requiredRubyVersion).toEqual([{ restriction: ">=", version: "2.3.0" }]);
    // The fixture's `version: '1.0'` row SURVIVES (only the `>= 0` default
    // pair drops — AsVersionRequirement's skip arm; the pin's unit test uses
    // '0' for its empty assert, the integration fixture carries 1.0 and the
    // info line renders `,rubygems:>= 1.0`).
    expect(parsed.metadata.requiredRubygemsVersion).toEqual([{ restriction: ">=", version: "1.0" }]);
    expect(parsed.metadata.runtimeDependencies).toEqual([
      {
        name: "runtime-dep",
        version: [
          { restriction: ">=", version: "1.2.0" },
          { restriction: "<", version: "2.0" },
        ],
      },
    ]);
    expect(parsed.metadata.developmentDependencies).toEqual([
      { name: "dev-dep", version: [{ restriction: "~>", version: "5.2" }] },
    ]);
  });

  it("missing metadata.gz → ErrMissingMetadataFile; structural tar failures are the 500 arm", async () => {
    const noMetadata = buildTar([{ name: "dummy.txt", mode: 0o644, data: new Uint8Array(0) }], true);
    expect(() => extractGemMetadataGz(noMetadata)).toThrow(/metadata\.gz file is missing/);
    await expect(parseRubyGemPackage(noMetadata)).rejects.toThrow(/metadata\.gz file is missing/);

    // 100 bytes of nonzero junk — Go tar.Next's io.ErrUnexpectedEOF arm.
    await expect(parseRubyGemPackage(new Uint8Array(100).fill(0x41))).rejects.toThrow(/unexpected EOF/);
    // Corrupt gzip metadata — gzip.NewReader's plain error → the 500 arm.
    const badGz = buildTar([{ name: "metadata.gz", mode: 0o644, data: new TextEncoder().encode("not gzip") }], true);
    await expect(parseRubyGemPackage(badGz)).rejects.toThrow(/gzip/);
  });

  it("invalid names reject (the metadata_test.go InvalidName rows)", async () => {
    for (const quotedName of [`"evil\\n1.0.0"`, `"a b"`, `"a/b"`, `""`]) {
      const yaml = `name: ${quotedName}\nversion:\n  version: 1\n`;
      const gem = buildTar(
        [{ name: "metadata.gz", mode: 0o644, data: await gzipCompress(new TextEncoder().encode(yaml)) }],
        true,
      );
      await expect(parseRubyGemPackage(gem), quotedName).rejects.toThrow(/package name is invalid/);
    }
  });

  it("the version grammar gates the upload (the versionMatcher table)", async () => {
    for (const version of ["alpha", "1..2", "-1.0", "1.0-alpha+build", "not a version!"]) {
      const gem = await makeRubyGem("g", "0", {
        metadataYaml: `--- !ruby/object:Gem::Specification\nname: g\nversion: !ruby/object:Gem::Version\n  version: "${version}"\n`,
      });
      await expect(parseRubyGemPackage(gem), version).rejects.toThrow(/package version is invalid/);
    }
    // Quoted (any accepted spelling stays a string through the parse — Go's
    // n.Value verbatim).
    for (const version of ["1", "1.0", "0.99", "1.0.5", "2.0.0.rc1", "1.0-pre.1", "10.2.1", "1.0-pre"]) {
      const gem = await makeRubyGem("g", "0", {
        metadataYaml: `--- !ruby/object:Gem::Specification\nname: g\nversion: !ruby/object:Gem::Version\n  version: "${version}"\n`,
      });
      await expect(parseRubyGemPackage(gem), version).resolves.toHaveProperty("version", version);
    }
  });

  it("newline-bearing indexed metadata rejects (the LineBreakInIndexedMetadata rows)", async () => {
    for (const field of [
      `platform: "ruby\\nx"`,
      `dependencies: [{name: "d\\nx"}]`,
      `dependencies: [{name: d, requirement: {requirements: [[">=", {version: "1\\nx"}]]}}]`,
      `required_ruby_version: {requirements: [[">=", {version: "1\\nx"}]]}`,
    ]) {
      const yaml = `name: g\nversion:\n  version: 1\n${field}\n`;
      const gem = buildTar(
        [{ name: "metadata.gz", mode: 0o644, data: await gzipCompress(new TextEncoder().encode(yaml)) }],
        true,
      );
      await expect(parseRubyGemPackage(gem), field).rejects.toThrow(/package metadata is invalid/);
    }
  });

  it("a structurally invalid YAML document is the decode-error arm (500 upstream)", async () => {
    const yaml = "- just\n- a sequence\n";
    const gem = buildTar(
      [{ name: "metadata.gz", mode: 0o644, data: await gzipCompress(new TextEncoder().encode(yaml)) }],
      true,
    );
    await expect(parseRubyGemPackage(gem)).rejects.toThrow(/cannot decode gem specification/);
  });

  it("a ZERO-BYTE metadata.gz member is the gzip.NewReader 500 arm", async () => {
    const gem = buildTar([{ name: "metadata.gz", mode: 0o644, data: new Uint8Array(0) }], true);
    await expect(parseRubyGemPackage(gem)).rejects.toThrow(/gzip/);
  });

  it("a metadata inflate past the 32 MiB cap throws ErrContentTooLarge (400)", async () => {
    const big = new Uint8Array(32 * 1024 * 1024 + 1); // zeros inflate tiny
    // The cap fires BEFORE the YAML decode (the NewLimitedReader order).
    const gem = buildTar([{ name: "metadata.gz", mode: 0o644, data: await gzipCompress(big) }], true);
    await expect(parseRubyGemPackage(gem)).rejects.toThrow(/content exceeds the size limit/);
  });

  it("AsVersionRequirement skips the malformed rows and the >= 0 default", () => {
    expect(asVersionRequirement([
      [">=", { version: "1.2" }],
      ["<", { version: "2" }],
    ])).toEqual([
      { restriction: ">=", version: "1.2" },
      { restriction: "<", version: "2" },
    ]);
    expect(
      asVersionRequirement([
        [">=", { version: "0" }], // the default pair drops
        [">="], // len != 2
        ["=", { version: 3 }], // non-string version
        ["~>", { other: "x" }], // no version key
        [7, { version: "1" }], // non-string restriction
        [">=", null],
        ["=", [">=", "1"]], // a seq holder is not a map
      ]),
    ).toEqual([]);
    expect(asVersionRequirement(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The round-trip — the integration test's arms
// ---------------------------------------------------------------------------

describe("rubygems upload → download/gemspec/info/versions round-trip", () => {
  it("uploads: 201, the SemverCompatible package, the metadata JSON, the ONE lead {name}-{version}.gem", async () => {
    await seedAliceWithGem();

    const pkgs = await db().select().from(packages).where(eq(packages.type, "rubygems")).all();
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.name).toBe("gitea");
    expect(pkgs[0]?.semverCompatible).toBe(true);
    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe("1.0.5");
    const metadata = JSON.parse(versions[0]?.metadataJson ?? "{}") as Record<string, unknown>;
    expect(metadata.platform).toBe("ruby");
    expect(metadata.summary).toBe("Gitea package");
    expect(metadata.project_url).toBe("https://gitea.io/");
    expect(Array.isArray(metadata.runtime_dependencies)).toBe(true);
  });

  it("re-publishing the same version answers 409 'package version already exists'", async () => {
    const { gem, writer } = await seedAliceWithGem();
    const conflict = await uploadGem("alice", gem, authHeaders(writer));
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toBe("package version already exists");
    expect(await db().select().from(packageVersions).all()).toHaveLength(1);
  });

  it("downloads byte-parity through the D-6 shape; the lead GET bumps the counter, HEAD does not", async () => {
    const { gem } = await seedAliceWithGem();

    const download = await protocol()("/api/packages/alice/rubygems/gems/gitea-1.0.5.gem");
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe("attachment; filename=gitea-1.0.5.gem");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(gem);

    const rows = await db().select().from(packageVersions).all();
    expect(rows[0]?.downloadCount).toBe(1);

    const head = await protocol()("/api/packages/alice/rubygems/gems/gitea-1.0.5.gem", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const rowsAfterHead = await db().select().from(packageVersions).all();
    expect(rowsAfterHead[0]?.downloadCount).toBe(1);
  });

  it("serves the gemspec.rz whose zlib inflate matches the integration test's EXACT Marshal bytes", async () => {
    await seedAliceWithGem();
    const res = await protocol()("/api/packages/alice/rubygems/quick/Marshal.4.8/gitea-1.0.5.gemspec.rz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=gitea-1.0.5.gemspec.rz");
    const inflated = await unzlib(new Uint8Array(await res.arrayBuffer()));
    // The upstream oracle byte string (api_packages_rubygems_test.go:254) —
    // a GO BYTE string: read it through latin-1 code units so the \xc3 stays
    // ONE byte (a JS literal would UTF-8-encode U+00C3 as two).
    const expectedLatin1 =
      "\x04\bu:\x17Gem::Specification\x01\xc3\x04\b[\x18I\"\n3.2.3\x06:\x06ETi\tI\"\ngitea\x06;\x00TU:\x11Gem::Version[\x06I\"\n1.0.5\x06;\x00T0I\"\x12Gitea package\x06;\x00T00I\"\truby\x06;\x00T[\x000I\"\x00\x06;\x00T[\x06I\"\nGitea\x06;\x00TI\"\x1aRubyGems package test\x06;\x00TI\"\x16https://gitea.io/\x06;\x00TTI\"\truby\x06;\x00T0[\x06I\"\bMIT\x06;\x00T";
    const expectedBytes = new Uint8Array(Array.from(expectedLatin1, (ch) => ch.charCodeAt(0) & 0xff));
    expect(Array.from(inflated)).toEqual(Array.from(expectedBytes));
    // The spec render helper agrees with the served bytes (an encoder-level
    // re-pin: same bytes through buildRubyGemSpecification).
    const direct = buildRubyGemSpecification("gitea", "1.0.5", {
      platform: "ruby",
      description: "RubyGems package test",
      summary: "Gitea package",
      authors: ["Gitea"],
      licenses: ["MIT"],
      requiredRubyVersion: [{ restriction: ">=", version: "2.3.0" }],
      requiredRubygemsVersion: [],
      projectUrl: "https://gitea.io/",
      runtimeDependencies: [],
      developmentDependencies: [],
    });
    expect(Array.from(direct)).toEqual(Array.from(expectedBytes));
  });

  it("a quick filename without .gemspec.rz answers the 501 EMPTY gate", async () => {
    await seedAliceWithGem();
    const res = await protocol()("/api/packages/alice/rubygems/quick/Marshal.4.8/gitea-1.0.5.gem");
    expect(res.status).toBe(501);
    expect(await res.text()).toBe("");
  });

  it("enumerates specs.4.8 / latest_specs.4.8 to the upstream payload bytes; prerelease is EMPTY", async () => {
    // The single-gem owner pins the integration test's vectors byte-for-byte
    // (the vectors encode exactly this store: one gem gitea-1.0.5, ruby).
    const owner = await seedUser("bob");
    const bobWriter = await token(owner, "write:package");
    const bobPut = await uploadGem("bob", await makeRubyGem("gitea", "1.0.5"), authHeaders(bobWriter));
    expect(bobPut.status).toBe(201);
    await bobPut.arrayBuffer();

    for (const endpoint of ["specs.4.8.gz", "latest_specs.4.8.gz"]) {
      const res = await protocol()(`/api/packages/bob/rubygems/${endpoint}`);
      expect(res.status, endpoint).toBe(200);
      const served = await gunzip(new Uint8Array(await res.arrayBuffer()));
      const oracle = await gunzip(base64ToBytes(ENUMERATE_VECTORS[endpoint.slice(0, -3)] as string));
      expect(Array.from(served), endpoint).toEqual(Array.from(oracle));
    }

    // prerelease_specs.4.8 is ALWAYS the empty list (rubygems.go:59-61).
    const pre = await protocol()("/api/packages/bob/rubygems/prerelease_specs.4.8.gz");
    expect(pre.status).toBe(200);
    expect(Array.from(await gunzip(new Uint8Array(await pre.arrayBuffer())))).toEqual(
      Array.from(await gunzip(base64ToBytes(ENUMERATE_VECTORS["prerelease_specs.4.8"] as string))),
    );
    expect(Array.from(buildRubyGemEmptySpecsPayload())).toEqual([4, 8, 0x5b, 0]);

    // A second gem → specs.4.8 lists BOTH, latest still one-per-package.
    const another = await makeRubyGem("gitea-another", "0.99");
    const put = await uploadGem("bob", another, authHeaders(bobWriter));
    expect(put.status).toBe(201);
    await put.arrayBuffer();
    const specs = await protocol()("/api/packages/bob/rubygems/specs.4.8.gz");
    const specsText = bytesText(await gunzip(new Uint8Array(await specs.arrayBuffer())));
    expect(specsText).toContain("gitea");
    expect(specsText).toContain("gitea-another");
    const latest = await protocol()("/api/packages/bob/rubygems/latest_specs.4.8.gz");
    const latestText = bytesText(await gunzip(new Uint8Array(await latest.arrayBuffer())));
    expect(latestText).toContain("gitea-another");
  });

  it("serves the compact index: info text and the versions lines EXACTLY as the integration test", async () => {
    const { gem, writer } = await seedAliceWithGem();
    const gemSha256 = await sha256Hex(gem);

    const info = await protocol()("/api/packages/alice/rubygems/info/gitea");
    expect(info.status).toBe(200);
    expect(info.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    const expectedInfo = `---\n1.0.5 runtime-dep:>= 1.2.0&< 2.0|checksum:${gemSha256},ruby:>= 2.3.0,rubygems:>= 1.0\n`;
    expect(await info.text()).toBe(expectedInfo);
    const infoMd5 = md5Hex(new TextEncoder().encode(expectedInfo));

    const another = await makeRubyGem("gitea-another", "0.99");
    const put = await uploadGem("alice", another, authHeaders(writer));
    expect(put.status).toBe(201);
    await put.arrayBuffer();
    const anotherSha = await sha256Hex(another);
    // ONLY runtime deps index on the compact line (rubygems.go:421's
    // RuntimeDependencies range — the dev-dep never renders).
    const anotherInfo = `---\n0.99 runtime-dep:>= 1.2.0&< 2.0|checksum:${anotherSha},ruby:>= 2.3.0,rubygems:>= 1.0\n`;
    const anotherMd5 = md5Hex(new TextEncoder().encode(anotherInfo));

    const versions = await protocol()("/api/packages/alice/rubygems/versions");
    expect(versions.status).toBe(200);
    expect(await versions.text()).toBe(`---\ngitea 1.0.5 ${infoMd5}\ngitea-another 0.99 ${anotherMd5}\n`);
  });

  it("info on a missing gem answers the EMPTY-404; versions on an empty store is the bare ---", async () => {
    await seedUser("alice");
    const info = await protocol()("/api/packages/alice/rubygems/info/ghost");
    expect(info.status).toBe(404);
    expect(await info.text()).toBe("");
    const versions = await protocol()("/api/packages/alice/rubygems/versions");
    expect(versions.status).toBe(200);
    expect(await versions.text()).toBe("---\n");
  });

  it("a platform gem stores {name}-{version}-{platform}.gem and the index renders the _platform suffix", async () => {
    const owner = await seedUser("carol");
    const writer = await token(owner, "write:package");
    const yaml = GEMSPEC_TEMPLATE("windows", "1.0").replace("platform: ruby", "platform: mswin");
    const gem = await makeRubyGem("windows", "1.0", { metadataYaml: yaml });
    const put = await uploadGem("carol", gem, authHeaders(writer));
    expect(put.status).toBe(201);
    expect(makeGemFullFileName("windows", "1.0", "mswin")).toBe("windows-1.0-mswin.gem");
    const download = await protocol()("/api/packages/carol/rubygems/gems/windows-1.0-mswin.gem");
    expect(download.status).toBe(200);
    await download.arrayBuffer();
    const versions = await protocol()("/api/packages/carol/rubygems/versions");
    expect(await versions.text()).toMatch(/^---\nwindows 1\.0_mswin [0-9a-f]{32}\n$/);
  });
});

// ---------------------------------------------------------------------------
// The yank walk + the missing-file contract
// ---------------------------------------------------------------------------

describe("rubygems yank + missing arms", () => {
  it("yanks through a multipart DELETE (the integration test's shape) → 200, then the 404s", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await uploadGem("alice", await makeRubyGem("gitea", "1.0.5"), authHeaders(writer));

    const form = new FormData();
    form.set("gem_name", "gitea");
    form.set("version", "1.0.5");
    const yank = await protocol()("/api/packages/alice/rubygems/api/v1/gems/yank", {
      method: "DELETE",
      headers: { ...authHeaders(writer) },
      body: form,
    });
    expect(yank.status).toBe(200);
    expect(await yank.text()).toBe("");
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);

    const info = await protocol()("/api/packages/alice/rubygems/info/gitea");
    expect(info.status).toBe(404);
    const versions = await protocol()("/api/packages/alice/rubygems/versions");
    expect(await versions.text()).toBe("---\n");
  });

  it("yank of an unknown gem answers 404 'package does not exist'", async () => {
    const owner = await seedUser("alice");
    const form = new FormData();
    form.set("gem_name", "ghost");
    form.set("version", "1.0.0");
    const yank = await protocol()("/api/packages/alice/rubygems/api/v1/gems/yank", {
      method: "DELETE",
      headers: { ...authHeaders(await token(owner, "write:package")) },
      body: form,
    });
    expect(yank.status).toBe(404);
    expect(await yank.text()).toBe("package does not exist");
  });

  it("a non-multipart yank body is the 500 arm (Go ParseMultipartForm's ErrNotMultipart)", async () => {
    const owner = await seedUser("alice");
    const yank = await protocol()("/api/packages/alice/rubygems/api/v1/gems/yank", {
      method: "DELETE",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...authHeaders(await token(owner, "write:package")),
      },
      body: "gem_name=gitea&version=1.0.5",
    });
    expect(yank.status).toBe(500);
    expect(await yank.text()).toBe("internal server error");
  });

  it("downloads of unknown files answer the EMPTY-404; a wrong .gemspec.rz name too", async () => {
    await seedAliceWithGem();
    const ghost = await protocol()("/api/packages/alice/rubygems/gems/ghost-1.0.0.gem");
    expect(ghost.status).toBe(404);
    expect(await ghost.text()).toBe("");
    const wrongVersion = await protocol()("/api/packages/alice/rubygems/quick/Marshal.4.8/gitea-9.9.9.gemspec.rz");
    expect(wrongVersion.status).toBe(404);
    expect(await wrongVersion.text()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Auth / quota / the family switch
// ---------------------------------------------------------------------------

describe("rubygems auth/quota arms", () => {
  it("anonymous upload → 401; wrong-scope token → 401", async () => {
    await seedUser("alice");
    const gem = await makeRubyGem("denied", "1.0.0");
    const anon = await uploadGem("alice", gem);
    expect(anon.status).toBe(401);
    expect(await anon.text()).toBe("user should have specific permission or be a site admin");

    const mallory = await seedUser("mallory");
    const wrongCategory = await token(mallory, "read:repository");
    const scoped = await uploadGem("mallory", gem, authHeaders(wrongCategory));
    expect(scoped.status).toBe(401);
    await scoped.text();
  });

  it("a PUBLIC owner's reads are anonymous; a PRIVATE owner's are the challenge", async () => {
    await seedAliceWithGem();
    const publicInfo = await protocol()("/api/packages/alice/rubygems/info/gitea");
    expect(publicInfo.status).toBe(200);
    const publicSpecs = await protocol()("/api/packages/alice/rubygems/specs.4.8.gz");
    expect(publicSpecs.status).toBe(200);
    await publicSpecs.arrayBuffer();

    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const stealthWriter = await token(privateOwner, "write:package");
    await uploadGem("stealth", await makeRubyGem("secret", "1.0.0"), authHeaders(stealthWriter));
    const privateInfo = await protocol()("/api/packages/stealth/rubygems/info/secret");
    expect(privateInfo.status).toBe(401);
    await privateInfo.text();
  });

  it("the 403 quota arms: the size cap, the +1 count boundary, the admin bypass", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");
    const gem = await makeRubyGem("quota", "1.0.0");

    const sizeCapped = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "1" })(
      "/api/packages/alice/rubygems/api/v1/gems",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...authHeaders(writer) },
        body: gem.slice(),
      },
    );
    expect(sizeCapped.status).toBe(403);
    expect(await sizeCapped.text()).toBe("maximum allowed package storage quota exceeded");

    const adminPut = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "1" })(
      "/api/packages/root/rubygems/api/v1/gems",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...authHeaders(adminWriter) },
        body: gem.slice(),
      },
    );
    expect(adminPut.status).toBe(201);
    await adminPut.arrayBuffer();

    const countEnv = { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" };
    const first = await protocol(countEnv)("/api/packages/alice/rubygems/api/v1/gems", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...authHeaders(writer) },
      body: (await makeRubyGem("counted", "1.0.0")).slice(),
    });
    expect(first.status).toBe(201);
    await first.arrayBuffer();
    const second = await protocol(countEnv)("/api/packages/alice/rubygems/api/v1/gems", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...authHeaders(writer) },
      body: (await makeRubyGem("counted", "2.0.0")).slice(),
    });
    expect(second.status).toBe(403);
    expect(await second.text()).toBe("maximum allowed package count exceeded");
  });

  it("PACKAGES_ENABLED=false 404s the family; an unknown owner 404s with the redirect message", async () => {
    await seedUser("alice");
    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const put = await disabled("/api/packages/alice/rubygems/api/v1/gems", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: (await makeRubyGem("hello", "1.0.0")).slice(),
    });
    expect(put.status).toBe(404);
    expect(await put.text()).toBe("not found");
    const specs = await disabled("/api/packages/alice/rubygems/specs.4.8.gz");
    expect(specs.status).toBe(404);

    const nobody = await protocol()("/api/packages/nobody/rubygems/specs.4.8.gz");
    expect(nobody.status).toBe(404);
    expect(await nobody.text()).toBe("user redirect does not exist [name: nobody]");
  });

  it("corrupt upload bodies answer the parse sentinels at the route", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // A tar with no metadata.gz → 400 missing.
    const missing = await uploadGem(
      "alice",
      buildTar([{ name: "dummy.txt", mode: 0o644, data: new Uint8Array(3) }], true),
      authHeaders(writer),
    );
    expect(missing.status).toBe(400);
    expect(await missing.text()).toBe("metadata.gz file is missing");
    // Pure garbage → the tar walk's 500 arm.
    const garbage = await uploadGem("alice", new TextEncoder().encode("this is not a gem"), authHeaders(writer));
    expect(garbage.status).toBe(500);
    expect(await garbage.text()).toBe("internal server error");
    // A valid name but invalid version → 400.
    const badVersionPut = await uploadGem(
      "alice",
      await makeRubyGem("badver", "0", {
        metadataYaml:
          '--- !ruby/object:Gem::Specification\nname: badver\nversion: !ruby/object:Gem::Version\n  version: "not a version!"\n',
      }),
      authHeaders(writer),
    );
    expect(badVersionPut.status).toBe(400);
    expect(await badVersionPut.text()).toBe("package version is invalid");
    // A valid gem but an invalid NAME → 400 (the metadata_test.go row).
    const badNamePut = await uploadGem(
      "alice",
      await makeRubyGem("badname", "0", {
        metadataYaml:
          '--- !ruby/object:Gem::Specification\nname: "a b"\nversion: !ruby/object:Gem::Version\n  version: 1\n',
      }),
      authHeaders(writer),
    );
    expect(badNamePut.status).toBe(400);
    expect(await badNamePut.text()).toBe("package name is invalid");
  });
});

// ---------------------------------------------------------------------------
// The store-level shape asserts
// ---------------------------------------------------------------------------

describe("rubygems store-level shapes", () => {
  it("the served specs payload equals buildRubyGemSpecsPayload over the service rows", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await uploadGem("alice", await makeRubyGem("gitea", "1.0.5"), authHeaders(writer));

    const entries = await listRubyGemVersionsByType(env.DB, owner.id);
    expect(entries).toHaveLength(1);
    const payload = buildRubyGemSpecsPayload(entries); // the MARSHAL bytes (the route gzips these)
    const served = await protocol()("/api/packages/alice/rubygems/specs.4.8.gz");
    const servedPayload = await gunzip(new Uint8Array(await served.arrayBuffer()));
    expect(Array.from(payload)).toEqual(Array.from(servedPayload));
    expect(bytesText(servedPayload)).toContain("Gem::Version");
    expect(bytesText(servedPayload)).toContain("1.0.5");
  });

  it("buildRubyGemCompactIndex renders the md5 lines over the info text", async () => {
    const { owner } = await seedAliceWithGem();
    const index = await buildRubyGemCompactIndex(env.DB, owner.id);
    expect(index.startsWith("---\n")).toBe(true);
    expect(index).toMatch(/^---\ngitea 1\.0\.5 [0-9a-f]{32}\n$/);
  });
});
