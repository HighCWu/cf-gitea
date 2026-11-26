/**
 * The Terraform MODULE registry battery (SPEC terraform-module-registry.md)
 * on real D1 + the real REPO_PACKS binding — upstream 5d9bfa1e14's
 * modules/packages/terraform_module/{hcl,parser,metadata}.go through the
 * SERVICE face (the terraform.test.ts precedent; the route arms ride the
 * packages-terraform-modules unit):
 *
 *  - TestParseModuleArchive's vectors VERBATIM: the full module (the
 *    required_providers object + legacy forms, configuration_aliases riding
 *    the provider object ignored, the comment with an unbalanced brace, the
 *    escaped-template description, the heredoc description, the trailing
 *    comment after a default, the UTF-8 BOM, the macOS AppleDouble and
 *    `.TF` case skips, examples/ skipped, the one-level modules/ grammar
 *    (deep dirs skipped), the .tf.json empty module, LICENSE never the
 *    readme), the submodules-only archive, the oversized-README drops, the
 *    directory-wrapped ErrNoRootModule, the 32 MiB ErrContentTooLarge, and
 *    the seven malformed never-panic sources;
 *  - TestValidateAddress's arms verbatim;
 *  - NormalizeVersion: the v-prefix fold, segment padding, prerelease +
 *    metadata passthrough, the reject set, the int64 segment boundary;
 *  - the signed archive code (base/tool.go:36-95): round-trip verify, the
 *    expiry window edges, the data binding, the tamper arms, the short and
 *    null code arms;
 *  - the upload walk (201-class rows: the `terraform-module` package, the
 *    canonical-semver version, the ONE lead module.tar.gz file with the
 *    verbatim bytes, metadata_json on the created arm, the created-arm
 *    webhook seam taken without throwing), the duplicate-version 409 class
 *    (v-prefix collision included), the quota arms with the admin bypass,
 *    and the GET-only download bump with byte parity.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageBlobs, packageFiles, packageVersions, packages, users } from "../../db/schema";
import {
  DuplicatePackageVersionError,
  QuotaTotalCountError,
  QuotaTotalSizeError,
  packagesQuotaFromEnv,
} from "./model";
import {
  TERRAFORM_MODULE_MAX_METADATA_SIZE,
  TerraformModuleAddressError,
  TerraformModuleArchiveError,
  TerraformModuleContentTooLargeError,
  TerraformModuleNoRootError,
  TerraformModuleVersionError,
  createTerraformArchiveTimeLimitCode,
  deleteTerraformModuleVersion,
  listTerraformModuleVersions,
  normalizeTerraformModuleVersion,
  openTerraformModuleArchiveForDownload,
  parseTerraformModuleArchive,
  resetTerraformModuleSigningCacheForTests,
  terraformModuleArchiveCodeData,
  uploadTerraformModule,
  validateTerraformModuleAddress,
  verifyTerraformArchiveTimeLimitCode,
  type TerraformModuleMetadata,
} from "./terraform-modules";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  resetTerraformModuleSigningCacheForTests();
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "repositories",
    "personal_access_tokens",
    "auth_failures",
    "system_keystore",
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

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Archive builders (the upstream test.WriteTarCompression shape)
// ---------------------------------------------------------------------------

function tarMember(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(encoder.encode(name).subarray(0, 100), 0);
  header.set(encoder.encode("0000644\0"), 100);
  header.set(encoder.encode("0000000\0"), 108);
  header.set(encoder.encode("0000000\0"), 116);
  header.set(encoder.encode(`${content.length.toString(8).padStart(11, "0")}\0`), 124);
  header.set(encoder.encode("00000000000\0"), 136);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
  padded.set(content);
  const out = new Uint8Array(512 + padded.length);
  out.set(header, 0);
  out.set(padded, 512);
  return out;
}

function buildTar(members: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [...members, new Uint8Array(1024)];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** buildArchive (parser_test.go:31-33): filename → content, one tar.gz. */
async function buildArchive(files: Record<string, string>): Promise<Uint8Array> {
  return gzipBytes(
    buildTar(
      Object.entries(files).map(([name, content]) => tarMember(name, encoder.encode(content))),
    ),
  );
}

async function parseArchive(files: Record<string, string>): Promise<TerraformModuleMetadata> {
  const archive = await buildArchive(files);
  return parseTerraformModuleArchive(new Blob([archive]).stream() as ReadableStream<Uint8Array>);
}

// ---------------------------------------------------------------------------
// TestParseModuleArchive — the pin's vectors verbatim
// ---------------------------------------------------------------------------

describe("parseTerraformModuleArchive (parser_test.go TestParseModuleArchive)", () => {
  it("parses the full-module vector: providers, inputs, outputs, submodules", async () => {
    const metadata = await parseArchive({
      "./main.tf":
        "\uFEFF" +
        `terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 5.0"
      configuration_aliases = [aws.alternate]
    }
    random = "~> 3.0"
  }
}
# an unbalanced { in a comment
locals {
  joined = "%{ for k, v in { a = "b" } }\${k}%{ endfor }"
}
variable "region" {
  type        = string
  description = "AWS region, not $\${var.template} }"
  default     = "eu-west-1" // trailing comment
}
variable "tags" {
  type = map(string)
  description = <<EOT
Tags }
EOT
}
output "vpc_id" {
  description = "VPC id"
  value       = aws_vpc.this.id
}
`,
      "README.md": "# vpc\n",
      "._main.tf": `variable "ignored" {}`,
      "backup.TF": `variable "ignored" {}`,
      "examples/basic/main.tf": `variable "ignored" {}`,
      "modules/net/main.tf": `variable "cidr" {}\n`,
      "modules/net/README.md": "# Net submodule\n",
      "modules/net/LICENSE": "must not become the readme",
      "modules/net/deep/main.tf": "",
      "modules/json/main.tf.json": "",
    });
    expect(metadata).toEqual({
      readme: "# vpc\n",
      root: {
        inputs: [
          { name: "region", type: "string", description: "AWS region, not ${var.template} }", default: '"eu-west-1"', required: false },
          { name: "tags", type: "map(string)", description: "Tags }\n", required: true },
        ],
        outputs: [{ name: "vpc_id", description: "VPC id" }],
        providers: [
          { name: "aws", source: "hashicorp/aws", version: "~> 5.0" },
          { name: "random", version: "~> 3.0" },
        ],
      },
      submodules: {
        json: { module: {} },
        net: { readme: "# Net submodule\n", module: { inputs: [{ name: "cidr", required: true }] } },
      },
    });
  });

  it("accepts a submodules-only archive (no root)", async () => {
    const metadata = await parseArchive({ "modules/net/main.tf": "" });
    expect(metadata).toEqual({ submodules: { net: { module: {} } } });
  });

  it("drops oversized READMEs but still parses the module bodies", async () => {
    const oversized = "#".repeat(1024 * 1024 + 1);
    const metadata = await parseArchive({
      "main.tf": "",
      "README.md": oversized,
      "modules/net/main.tf": "",
      "modules/net/README.md": oversized,
    });
    expect(metadata).toEqual({ root: {}, submodules: { net: { module: {} } } });
  });

  it("answers ErrNoRootModule for a directory-wrapped module", async () => {
    await expect(parseArchive({ "mod-1.0.0/main.tf": "" })).rejects.toBeInstanceOf(TerraformModuleNoRootError);
  });

  it("answers ErrContentTooLarge at the 32 MiB decompressed cap", async () => {
    // header(512) + 32 MiB of '#' + the 1024-byte trailer — the total
    // decompressed stream passes the cap (the limited_reader.go N=limit+1
    // trip), exactly the pin's strings.Repeat("#", MaxMetadataSize) vector.
    const big = new Uint8Array(TERRAFORM_MODULE_MAX_METADATA_SIZE).fill(0x23);
    const archive = await gzipBytes(buildTar([tarMember("main.tf", big)]));
    await expect(
      parseTerraformModuleArchive(new Blob([archive]).stream() as ReadableStream<Uint8Array>),
    ).rejects.toBeInstanceOf(TerraformModuleContentTooLargeError);
  });

  it("never panics on the seven malformed sources (hcl.go's degrade arms)", async () => {
    for (const src of [
      'variable "x" { description = "',
      'variable "x" { description = "\\',
      "x = <<EOT",
      "/*",
      "variable {",
      '"${"${',
      "}}}",
    ]) {
      const metadata = await parseArchive({ "main.tf": src });
      expect(metadata.root).toBeDefined();
    }
  });

  it("answers a clear gzip error for non-gzip bytes", async () => {
    await expect(
      parseTerraformModuleArchive(new Blob([encoder.encode("not gzip at all")]).stream() as ReadableStream<Uint8Array>),
    ).rejects.toBeInstanceOf(TerraformModuleArchiveError);
  });
});

// ---------------------------------------------------------------------------
// TestValidateAddress — the pin's arms verbatim
// ---------------------------------------------------------------------------

describe("validateTerraformModuleAddress (parser_test.go TestValidateAddress)", () => {
  it("accepts org / My_vpc-2 / azurerm", () => {
    expect(() => validateTerraformModuleAddress("org", "My_vpc-2", "azurerm")).not.toThrow();
  });
  it("rejects the john.doe namespace", () => {
    expect(() => validateTerraformModuleAddress("john.doe", "vpc", "aws")).toThrowError(TerraformModuleAddressError);
  });
  it("rejects the vpc- name", () => {
    expect(() => validateTerraformModuleAddress("org", "vpc-", "aws")).toThrowError(/module name is invalid/);
  });
  it("rejects the my-cloud provider", () => {
    expect(() => validateTerraformModuleAddress("org", "vpc", "my-cloud")).toThrowError(/module provider is invalid/);
  });
});

// ---------------------------------------------------------------------------
// NormalizeVersion — hashicorp/go-version NewSemver+String
// ---------------------------------------------------------------------------

describe("normalizeTerraformModuleVersion (parser.go:39-44)", () => {
  it("folds the v-prefix (v1.0.0 == 1.0.0)", () => {
    expect(normalizeTerraformModuleVersion("v1.0.0")).toBe("1.0.0");
    expect(normalizeTerraformModuleVersion("1.0.0")).toBe("1.0.0");
  });
  it("pads missing segments with zeros", () => {
    expect(normalizeTerraformModuleVersion("v1.2")).toBe("1.2.0");
    expect(normalizeTerraformModuleVersion("1")).toBe("1.0.0");
  });
  it("keeps prerelease and metadata", () => {
    expect(normalizeTerraformModuleVersion("v1.2.3-rc.1+meta")).toBe("1.2.3-rc.1+meta");
    expect(normalizeTerraformModuleVersion("1.0.0-1")).toBe("1.0.0-1");
  });
  it("keeps four-segment versions", () => {
    expect(normalizeTerraformModuleVersion("1.2.3.4")).toBe("1.2.3.4");
  });
  it("rejects the non-semver shapes", () => {
    for (const raw of ["", "v", "abc", "1.0.0alpha", "1..2", "latest"]) {
      expect(() => normalizeTerraformModuleVersion(raw)).toThrowError(TerraformModuleVersionError);
    }
  });
  it("honors Go's int64 segment width", () => {
    expect(normalizeTerraformModuleVersion("9223372036854775807.0.0")).toBe("9223372036854775807.0.0");
    expect(() => normalizeTerraformModuleVersion("9223372036854775808.0.0")).toThrowError(TerraformModuleVersionError);
  });
});

// ---------------------------------------------------------------------------
// The signed archive code (base/tool.go:36-95) — 10-minute window
// ---------------------------------------------------------------------------

describe("the signed archive time-limit code", () => {
  const now = new Date("2026-11-26T10:30:00Z");
  const data = terraformModuleArchiveCodeData(7, "vpc/aws", "1.0.0");

  it("creates a 58-char code and verifies it inside the window", async () => {
    const code = await createTerraformArchiveTimeLimitCode(env.DB, data, 10, now);
    expect(code).toHaveLength(58);
    expect(code.slice(0, 12)).toBe("202611261030");
    expect(code.slice(12, 18)).toBe("000010");
    expect(await verifyTerraformArchiveTimeLimitCode(env.DB, new Date("2026-11-26T10:30:00Z"), data, 10, code)).toBe(true);
    expect(await verifyTerraformArchiveTimeLimitCode(env.DB, new Date("2026-11-26T10:39:59Z"), data, 10, code)).toBe(true);
  });

  it("expires exactly at start+minutes", async () => {
    const code = await createTerraformArchiveTimeLimitCode(env.DB, data, 10, now);
    expect(await verifyTerraformArchiveTimeLimitCode(env.DB, new Date("2026-11-26T10:40:00Z"), data, 10, code)).toBe(false);
  });

  it("binds the code to its data (owner/name/version)", async () => {
    const code = await createTerraformArchiveTimeLimitCode(env.DB, data, 10, now);
    expect(
      await verifyTerraformArchiveTimeLimitCode(env.DB, new Date("2026-11-26T10:31:00Z"), terraformModuleArchiveCodeData(7, "vpc/aws", "1.0.1"), 10, code),
    ).toBe(false);
    expect(
      await verifyTerraformArchiveTimeLimitCode(env.DB, new Date("2026-11-26T10:31:00Z"), terraformModuleArchiveCodeData(8, "vpc/aws", "1.0.0"), 10, code),
    ).toBe(false);
  });

  it("rejects tampered, short, and null codes", async () => {
    const code = await createTerraformArchiveTimeLimitCode(env.DB, data, 10, now);
    const tampered = "202611261031" + code.slice(12);
    expect(await verifyTerraformArchiveTimeLimitCode(env.DB, new Date("2026-11-26T10:31:00Z"), data, 10, tampered)).toBe(false);
    expect(await verifyTerraformArchiveTimeLimitCode(env.DB, new Date("2026-11-26T10:31:00Z"), data, 10, code.slice(0, 18))).toBe(false);
    expect(await verifyTerraformArchiveTimeLimitCode(env.DB, new Date("2026-11-26T10:31:00Z"), data, 10, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The upload / list / download / delete walks (the router's service half)
// ---------------------------------------------------------------------------

async function seedOwner(): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username: "moduleowner",
      usernameLower: "moduleowner",
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

const ownerRow = (id: number) => ({ id, type: "user", visibility: "public" as const });
const doerOf = (id: number) => ({ id, isAdmin: false });

const FULL_FILES: Record<string, string> = {
  "main.tf": `variable "region" {\n  default = "eu-west-1"\n}\n`,
  "README.md": "# vpc\n",
};

async function upload(input: {
  ownerId: number;
  files?: Record<string, string>;
  version?: string;
  quota?: ReturnType<typeof packagesQuotaFromEnv>;
  withWebhook?: boolean;
  isAdmin?: boolean;
}): Promise<{ version: string }> {
  const files = input.files ?? FULL_FILES;
  const archive = await buildArchive(files);
  const result = await uploadTerraformModule({
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner: ownerRow(input.ownerId),
    doer: input.isAdmin ? { id: input.ownerId, isAdmin: true } : doerOf(input.ownerId),
    name: "vpc",
    provider: "aws",
    version: input.version ?? "1.0.0",
    content: new Blob([archive]).stream() as ReadableStream<Uint8Array>,
    declaredLength: archive.length,
    quota: input.quota ?? packagesQuotaFromEnv({}),
    webhookEnv: input.withWebhook === false ? undefined : env,
  });
  return { version: result.version.version };
}

describe("uploadTerraformModule", () => {
  it("creates the package, the canonical version, the lead file, and the metadata", async () => {
    const owner = await seedOwner();
    const { version } = await upload({ ownerId: owner.id, version: "v1.0.0" });
    expect(version).toBe("1.0.0");

    const pkg = (await db().select().from(packages).get())!;
    expect(pkg.type).toBe("terraform-module");
    expect(pkg.name).toBe("vpc/aws");
    expect(pkg.lowerName).toBe("vpc/aws");
    expect(pkg.semverCompatible).toBe(true);

    const versionRow = (await db().select().from(packageVersions).where(eq(packageVersions.packageId, pkg.id)).get())!;
    expect(versionRow.version).toBe("1.0.0");
    const metadata = JSON.parse(versionRow.metadataJson ?? "") as TerraformModuleMetadata;
    // Go omitempty: the absent `type` attr keeps the key off the wire.
    expect(metadata.root!.inputs).toEqual([{ name: "region", default: '"eu-west-1"', required: false }]);
    expect(metadata.readme).toBe("# vpc\n");

    const file = (await db().select().from(packageFiles).where(eq(packageFiles.versionId, versionRow.id)).get())!;
    expect(file.name).toBe("module.tar.gz");
    expect(file.isLead).toBe(true);

    // The blob round-trips VERBATIM (stored archive == the built bytes).
    const blob = (await db().select().from(packageBlobs).get())!;
    const object = (await env.REPO_PACKS.get(
      `packages/blobs/${blob.hashSha256.slice(0, 2)}/${blob.hashSha256.slice(2, 4)}/${blob.hashSha256}`,
    ))!;
    const stored = new Uint8Array(await object.arrayBuffer());
    const original = await buildArchive(FULL_FILES);
    expect(stored).toEqual(original);
  });

  it("answers DuplicatePackageVersionError on a re-upload (v-prefix included)", async () => {
    const owner = await seedOwner();
    await upload({ ownerId: owner.id, version: "1.0.0" });
    await expect(upload({ ownerId: owner.id, version: "v1.0.0" })).rejects.toBeInstanceOf(DuplicatePackageVersionError);
    // The stored metadata is untouched by the refused walk.
    const versionRow = (await db().select().from(packageVersions).get())!;
    expect(JSON.parse(versionRow.metadataJson ?? "")).toHaveProperty("root");
  });

  it("answers QuotaTotalCountError past the owner count cap", async () => {
    const owner = await seedOwner();
    const quota = { ...packagesQuotaFromEnv({}), limitTotalOwnerCount: 1 };
    await upload({ ownerId: owner.id, version: "1.0.0", quota });
    await expect(upload({ ownerId: owner.id, version: "1.0.1", quota })).rejects.toBeInstanceOf(QuotaTotalCountError);
  });

  it("the generic per-type cap does NOT bind this type (the lattice posture — upstream's default LIMIT_SIZE_TERRAFORM_MODULE = -1 is the same no-cap)", async () => {
    const owner = await seedOwner();
    const quota = { ...packagesQuotaFromEnv({}), limitSizeGeneric: 4 };
    const result = await upload({ ownerId: owner.id, files: { "main.tf": "x".repeat(4096) }, quota });
    expect(result.version).toBe("1.0.0");
  });

  it("answers QuotaTotalSizeError past the owner total", async () => {
    const owner = await seedOwner();
    const quota = { ...packagesQuotaFromEnv({}), limitTotalOwnerSize: 4 };
    await expect(upload({ ownerId: owner.id, files: { "main.tf": "x".repeat(4096) }, quota })).rejects.toBeInstanceOf(
      QuotaTotalSizeError,
    );
  });

  it("the admin bypasses the owner-total gate", async () => {
    const owner = await seedOwner();
    const quota = { ...packagesQuotaFromEnv({}), limitTotalOwnerSize: 4 };
    const result = await upload({ ownerId: owner.id, files: { "main.tf": "x".repeat(4096) }, quota, isAdmin: true });
    expect(result.version).toBe("1.0.0");
  });
});

describe("listTerraformModuleVersions + the download/delete walks", () => {
  it("lists versions across the package", async () => {
    const owner = await seedOwner();
    await upload({ ownerId: owner.id, version: "1.0.0" });
    await upload({ ownerId: owner.id, version: "1.1.0" });
    const versions = await listTerraformModuleVersions(env.DB, owner.id, "vpc/aws");
    expect(versions).toContain("1.0.0");
    expect(versions).toContain("1.1.0");
  });

  it("downloads the archive with the GET-only bump", async () => {
    const owner = await seedOwner();
    await upload({ ownerId: owner.id, version: "1.0.0" });
    expect((await db().select().from(packageVersions).get())!.downloadCount).toBe(0);
    const download = await openTerraformModuleArchiveForDownload(
      env.DB,
      env.REPO_PACKS,
      ownerRow(owner.id),
      "vpc/aws",
      "1.0.0",
      "GET",
    );
    expect(download.kind).toBe("ok");
    if (download.kind !== "ok") throw new Error("download missing");
    expect(download).not.toBeNull();
    const reader = (download.stream as ReadableStream<Uint8Array>).getReader();
    let length = 0;
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      length += read.value.byteLength;
    }
    expect(length).toBe(download.size);
    expect((await db().select().from(packageVersions).get())!.downloadCount).toBe(1);
    // HEAD does not bump.
    await openTerraformModuleArchiveForDownload(env.DB, env.REPO_PACKS, ownerRow(owner.id), "vpc/aws", "1.0.0", "HEAD");
    expect((await db().select().from(packageVersions).get())!.downloadCount).toBe(1);
  });

  it("answers null for a missing version and deletes by normalized version", async () => {
    const owner = await seedOwner();
    await upload({ ownerId: owner.id, version: "1.0.0" });
    expect(await openTerraformModuleArchiveForDownload(env.DB, env.REPO_PACKS, ownerRow(owner.id), "vpc/aws", "2.0.0", "GET")).toEqual({ kind: "version-missing" });
    expect(await deleteTerraformModuleVersion(env.DB, owner.id, "vpc/aws", "v1.0.0")).toBe(false);
    const normalized = normalizeTerraformModuleVersion("v1.0.0");
    expect(await deleteTerraformModuleVersion(env.DB, owner.id, "vpc/aws", normalized)).toBe(true);
    expect(await listTerraformModuleVersions(env.DB, owner.id, "vpc/aws")).toEqual([]);
  });
});
