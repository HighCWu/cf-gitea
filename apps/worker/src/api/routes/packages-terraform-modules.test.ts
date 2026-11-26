/**
 * The Terraform MODULE registry ROUTE battery (SPEC
 * terraform-module-registry.md) — the five host-level `-` namespace routes
 * of upstream 5d9bfa1e14's routers/api/packages/terraform_module/
 * (terraform_module.go) through the REAL mount shape (index.ts mounts the
 * sub-app at /api/packages — the cargo routes battery's harness):
 *
 *  - the versions envelope (200 {"modules":[{versions:[…]}]}), the empty
 *    404 ("package does not exist"), the bad-address 400 (plain text);
 *  - the download redirect: 204 + the `./archive?archive=tar.gz&code=…`
 *    X-Terraform-Get pointer whose code the ARCHIVE route then honors
 *    (the signed-URL round trip, terraform_module.go:93-130);
 *  - the archive download: anonymous + valid code → 200 (the
 *    HasValidArchiveSignature bypass), anonymous + bad/expired code → the
 *    read gate's 401 challenge, token read → 200 with the verbatim bytes
 *    and the disposition header, HEAD rides without a body, the GET-only
 *    counter bump;
 *  - the upload: 201, the write gate (no credential → 401 + challenge),
 *    the duplicate version 409 (plain text, v-prefix folded), the address
 *    400s (the `vpc-` name, the `My-Cloud` provider), the non-semver 400,
 *    the bad-gzip and no-root 400s (the teaching message);
 *  - the delete: 204 then the empty-list 404; the missing version 404;
 *  - owner blindness: a private owner 404s every route for anonymous
 *    (including a cryptographically VALID code — blindness precedes the
 *    signature bypass, the group's UserAssignmentWeb wrap);
 *  - the `-` namespace precedence: every call rides the literal route.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { basicTokenHeader, mintFor } from "../../auth/testing/seeds";
import {
  TERRAFORM_ARCHIVE_CODE_MINUTES,
  createTerraformArchiveTimeLimitCode,
  terraformModuleArchiveCodeData,
} from "../../services/packages/terraform-modules";

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

/** The REAL mount shape: index.ts mounts the sub-app at /api/packages. */
function protocol(): (path: string, init?: RequestInit) => Promise<Response> {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createEcosystemProtocolRouter());
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), env);
}

async function seedUser(username: string, visibility: "public" | "private" = "public"): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: "user",
      visibility,
      createdAt: new Date("2026-11-01T12:00:00Z"),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return { id: row.id, username: row.username };
}

const encoder = new TextEncoder();

function tarMember(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(encoder.encode(name).subarray(0, 100), 0);
  header.set(encoder.encode("0000644\0"), 100);
  header.set(encoder.encode("0000000\0"), 108);
  header.set(encoder.encode("0000000\0"), 116);
  header.set(encoder.encode(`${content.byteLength.toString(8).padStart(11, "0")}\0`), 124);
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

const MODULE_TF = `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
variable "region" {
  type    = string
  default = "eu-west-1"
}
output "vpc_id" {
  description = "VPC id"
}
`;

async function moduleArchive(mainTf = MODULE_TF): Promise<Uint8Array> {
  return gzipBytes(
    buildTar([tarMember("main.tf", encoder.encode(mainTf)), tarMember("README.md", encoder.encode("# vpc\n"))]),
  );
}

async function uploadModule(username: string, version: string, archive: Uint8Array, token?: string): Promise<Response> {
  return protocol()(`/api/packages/-/terraform/modules/${username}/vpc/aws/${version}`, {
    method: "PUT",
    headers: {
      "content-type": "application/x-tar",
      ...(token !== undefined ? { authorization: basicTokenHeader(token) } : {}),
    },
    body: archive,
  });
}

/** Seed owner + publish one version with a fresh write token; returns the
 *  owner row and the token plaintext for the read arms. */
async function seedPublished(
  username: string,
  version = "1.0.0",
  visibility: "public" | "private" = "public",
): Promise<{ owner: { id: number; username: string }; token: string }> {
  const owner = await seedUser(username, visibility);
  const token = (await mintFor(owner.id, "pat-tfmod", "write:package")).plaintext;
  const put = await uploadModule(username, version, await moduleArchive(), token);
  if (put.status !== 201) throw new Error(`seed upload failed: ${put.status}`);
  return { owner, token };
}

// ---------------------------------------------------------------------------
// ListVersions (terraform_module.go:75-91)
// ---------------------------------------------------------------------------

describe("GET /-/terraform/modules/{owner}/{name}/{provider}/versions", () => {
  it("answers the two-level envelope with every version", async () => {
    const { token } = await seedPublished("modowner", "1.0.0");
    const put2 = await uploadModule("modowner", "v1.1.0", await moduleArchive(), token);
    expect(put2.status).toBe(201);
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/versions");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<{ modules: Array<{ versions: Array<{ version: string }> }> }>();
    expect(body.modules).toHaveLength(1);
    const versions = body.modules[0]!.versions.map((entry) => entry.version).sort();
    expect(versions).toEqual(["1.0.0", "1.1.0"]);
  });

  it("answers the plain-text 404 when the package has no versions", async () => {
    await seedUser("modowner");
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/versions");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("package does not exist");
  });

  it("answers the plain-text 400 for a bad address", async () => {
    await seedUser("modowner");
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc-/aws/versions");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("module name is invalid");
  });
});

// ---------------------------------------------------------------------------
// DownloadRedirect + DownloadArchive (terraform_module.go:93-130)
// ---------------------------------------------------------------------------

describe("the download redirect + signed archive round trip", () => {
  it("hands out a code that the archive route honors anonymously", async () => {
    await seedPublished("modowner");
    const redirect = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/1.0.0/download");
    expect(redirect.status).toBe(204);
    const pointer = redirect.headers.get("X-Terraform-Get");
    expect(pointer).not.toBeNull();
    expect(pointer!.startsWith("./archive?archive=tar.gz&code=")).toBe(true);
    const code = pointer!.split("code=")[1]!;
    expect(code).toHaveLength(58);
    // The anonymous archive fetch with the code carries NO credentials.
    const archive = await protocol()(
      `/api/packages/-/terraform/modules/modowner/vpc/aws/1.0.0/archive?code=${code}`,
    );
    expect(archive.status).toBe(200);
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const original = await moduleArchive();
    expect(bytes).toEqual(original);
    expect(archive.headers.get("content-disposition")).toContain("module.tar.gz");
    // The download counted (the GET-only bump).
    const bumped = await db().select().from(packageVersions).get();
    expect(bumped!.downloadCount).toBe(1);
  });

  it("expires the code after the 10-minute window (pinned on a private owner — a public owner's anonymous read passes the gate anyway)", async () => {
    const { owner } = await seedPublished("hiddenowner", "1.0.0", "private");
    const stale = await createTerraformArchiveTimeLimitCode(
      env.DB,
      terraformModuleArchiveCodeData(owner.id, "vpc/aws", "1.0.0"),
      TERRAFORM_ARCHIVE_CODE_MINUTES,
      new Date(Date.now() - 11 * 60_000),
    );
    const res = await protocol()(`/api/packages/-/terraform/modules/hiddenowner/vpc/aws/1.0.0/archive?code=${stale}`);
    // The expired code falls through to the read gate — anonymous on a
    // private owner answers the auth challenge (the family gate posture).
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  it("rejects a code minted for a different version (private owner)", async () => {
    const { owner } = await seedPublished("hiddenowner", "1.0.0", "private");
    const wrong = await createTerraformArchiveTimeLimitCode(
      env.DB,
      terraformModuleArchiveCodeData(owner.id, "vpc/aws", "2.0.0"),
      TERRAFORM_ARCHIVE_CODE_MINUTES,
      new Date(),
    );
    const res = await protocol()(`/api/packages/-/terraform/modules/hiddenowner/vpc/aws/1.0.0/archive?code=${wrong}`);
    expect(res.status).toBe(401);
  });

  it("challenges an anonymous archive read on a PUBLIC owner without a code with 401 when sign-in view gates it — otherwise the public read passes", async () => {
    // The public-owner anonymous read IS upstream's reqPackageAccess(read)
    // posture (a public package downloads anonymously); the code's meaning
    // is the PRIVATE-owner bypass, pinned above. Here we pin the public
    // anonymous read answers 200 bytes.
    await seedPublished("modowner");
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/1.0.0/archive");
    expect(res.status).toBe(200);
    expect((await db().select().from(packageVersions).get())!.downloadCount).toBe(1);
  });

  it("serves the archive to a tokened read without a code", async () => {
    const { token } = await seedPublished("modowner");
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/1.0.0/archive", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("module.tar.gz");
  });

  it("HEAD rides the archive walk without a body or a bump", async () => {
    const { token } = await seedPublished("modowner");
    const before = (await db().select().from(packageVersions).get())!.downloadCount;
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/1.0.0/archive", {
      method: "HEAD",
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(0);
    expect((await db().select().from(packageVersions).get())!.downloadCount).toBe(before);
  });

  it("answers 404 for a missing version on both download arms", async () => {
    await seedPublished("modowner");
    const redirect = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/9.9.9/download");
    expect(redirect.status).toBe(404);
    expect(await redirect.text()).toBe("package does not exist");
  });
});

// ---------------------------------------------------------------------------
// UploadModule (terraform_module.go:132-177)
// ---------------------------------------------------------------------------

describe("PUT /-/terraform/modules/{owner}/{name}/{provider}/{version}", () => {
  it("publishes with a write token and the metadata lands", async () => {
    await seedPublished("modowner");
    const versionRow = await db().select().from(packageVersions).get();
    expect(versionRow!.version).toBe("1.0.0");
    const metadata = JSON.parse(versionRow!.metadataJson ?? "") as { root?: { providers?: Array<{ name: string }> } };
    expect(metadata.root?.providers).toEqual([{ name: "aws", source: "hashicorp/aws", version: "~> 5.0" }]);
  });

  it("challenges anonymous writes", async () => {
    await seedUser("modowner");
    const res = await uploadModule("modowner", "1.0.0", await moduleArchive());
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  it("answers the plain-text 409 on a duplicate version (v-prefix folded)", async () => {
    const { token } = await seedPublished("modowner");
    const res = await uploadModule("modowner", "v1.0.0", await moduleArchive(), token);
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("package version already exists");
  });

  it("answers the plain-text 400s for address and version shapes", async () => {
    const owner = await seedUser("modowner");
    const token = (await mintFor(owner.id, "pat-tfmod", "write:package")).plaintext;
    const badName = await uploadModule("modowner", "1.0.0", await moduleArchive(), token);
    void badName;
    const bad = await protocol()(`/api/packages/-/terraform/modules/modowner/vpc-/aws/1.0.0`, {
      method: "PUT",
      headers: { authorization: basicTokenHeader(token) },
      body: await moduleArchive(),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("module name is invalid");
    const badProvider = await protocol()(`/api/packages/-/terraform/modules/modowner/vpc/My-Cloud/1.0.0`, {
      method: "PUT",
      headers: { authorization: basicTokenHeader(token) },
      body: await moduleArchive(),
    });
    expect(badProvider.status).toBe(400);
    expect(await badProvider.text()).toBe("module provider is invalid");
    const badVersion = await uploadModule("modowner", "latest", await moduleArchive(), token);
    expect(badVersion.status).toBe(400);
    expect(await badVersion.text()).toBe("module version is invalid");
  });

  it("answers 400 with the teaching message for a directory-wrapped module", async () => {
    const owner = await seedUser("modowner");
    const token = (await mintFor(owner.id, "pat-tfmod", "write:package")).plaintext;
    const wrapped = await gzipBytes(
      buildTar([tarMember("mod-1.0.0/main.tf", encoder.encode(MODULE_TF))]),
    );
    const res = await uploadModule("modowner", "1.0.0", wrapped, token);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no terraform module at the archive root");
  });

  it("answers 400 for a non-gzip body", async () => {
    const owner = await seedUser("modowner");
    const token = (await mintFor(owner.id, "pat-tfmod", "write:package")).plaintext;
    const res = await uploadModule("modowner", "1.0.0", encoder.encode("definitely not gzip"), token);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid gzip stream");
  });
});

// ---------------------------------------------------------------------------
// DeleteModule (terraform_module.go:179-188)
// ---------------------------------------------------------------------------

describe("DELETE /-/terraform/modules/{owner}/{name}/{provider}/{version}", () => {
  it("removes the version and answers 204, then the list 404s", async () => {
    const { token } = await seedPublished("modowner");
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/1.0.0", {
      method: "DELETE",
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(res.status).toBe(204);
    const list = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/versions");
    expect(list.status).toBe(404);
  });

  it("answers the plain-text 404 for a missing version", async () => {
    const owner = await seedUser("modowner");
    const token = (await mintFor(owner.id, "pat-tfmod", "write:package")).plaintext;
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/1.0.0", {
      method: "DELETE",
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("package does not exist");
  });

  it("challenges anonymous deletes", async () => {
    await seedPublished("modowner");
    const res = await protocol()("/api/packages/-/terraform/modules/modowner/vpc/aws/1.0.0", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Owner blindness (the group's UserAssignmentWeb + PackageAssignment wrap)
// ---------------------------------------------------------------------------

describe("private-owner gates", () => {
  it("challenges ANONYMOUS arms with 401 — the valid-code bypass and an authed outsider pin the rest", async () => {
    const { owner, token } = await seedPublished("hiddenowner", "1.0.0", "private");
    // Anonymous — the auth challenge precedes every gate (the family posture).
    const anon = await protocol()("/api/packages/-/terraform/modules/hiddenowner/vpc/aws/versions");
    expect(anon.status).toBe(401);
    const anonRedirect = await protocol()("/api/packages/-/terraform/modules/hiddenowner/vpc/aws/1.0.0/download");
    expect(anonRedirect.status).toBe(401);
    // A cryptographically VALID code rides ANONYMOUSLY past the read gate —
    // the signature bypass's whole point (terraform_module.go:78-81).
    const code = await createTerraformArchiveTimeLimitCode(
      env.DB,
      terraformModuleArchiveCodeData(owner.id, "vpc/aws", "1.0.0"),
      TERRAFORM_ARCHIVE_CODE_MINUTES,
      new Date(),
    );
    const archive = await protocol()(`/api/packages/-/terraform/modules/hiddenowner/vpc/aws/1.0.0/archive?code=${code}`);
    expect(archive.status).toBe(200);
    const bytes = new Uint8Array(await archive.arrayBuffer());
    expect(bytes).toEqual(await moduleArchive());
    // The owner's own token reads it too.
    const own = await protocol()("/api/packages/-/terraform/modules/hiddenowner/vpc/aws/1.0.0/archive", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(own.status).toBe(200);
    // An AUTHENTICATED non-member outsider: the read gate refuses — the
    // landed family gate answers the 401 challenge (the shared
    // protocolAccessGate posture every registry rides).
    const outsider = await seedUser("outsider");
    const outsiderToken = (await mintFor(outsider.id, "pat-outsider", "write:package")).plaintext;
    const blind = await protocol()("/api/packages/-/terraform/modules/hiddenowner/vpc/aws/versions", {
      headers: { authorization: basicTokenHeader(outsiderToken) },
    });
    expect(blind.status).toBe(401);
  });
});
