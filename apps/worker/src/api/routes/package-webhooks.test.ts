/**
 * The `package` webhook emission matrix (GAPS #8) — the SPEC-0016 registry's
 * write arms firing the landed seam (services/packages/webhooks.ts) on real
 * D1:
 *
 *  - the created arm: the generic PUT fires `package` action=created with
 *    the notifyPackage payload shape (notifier.go:976-993 — action/package/
 *    repository:null/organization/sender; the inner ToPackage field set,
 *    services/convert/package.go:16-40), gated on versionCreated;
 *  - the version-added arm: a SECOND version fires again; a second FILE on
 *    an existing version stays silent (packages.go:131's `if created` =
 *    versionCreated, the duplicate-version re-publish fires nothing);
 *  - the deleted arms: the generic version DELETE and the file DELETE's
 *    cascade fire action=deleted (packages.go:532/:572 — the file arm
 *    notifies ONLY when the version went); a surviving file stays silent;
 *  - the whole-package DELETE fires ONE EVENT PER VERSION
 *    (packages.go:714's `for _, pd := range pds` loop);
 *  - delivery conditions: inactive hooks, non-subscribed (push-only) hooks
 *    and push_only stay silent; send_everything and an explicit
 *    `package: true` subscription fire; an owner-scoped package routes the
 *    emission to the OWNER hooks (repoId "" — upstream's EventSource has no
 *    Repository for an unlinked package, webhook.go:207).
 */

import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { orgMembers, packageVersions, packages, users, webhookDeliveries, webhooks } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { resolveAuth } from "../../auth";
import { giteaErrorHandler } from "../errors";
import { mintFor } from "../../auth/testing/seeds";
import type { ApiEnv } from "../env";
import { createPackagesProtocolRouter, registerPackagesRoutes } from "./packages";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { buildTar, gzipCompress } from "../../services/packages/distro-common";
import type { User } from "../models/user";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "personal_access_tokens",
    "auth_failures",
    "repositories",
    "org_members",
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
const APP_URL = "https://hooks.example";
const NOW = new Date("2026-11-04T00:00:00Z");

// ---------------------------------------------------------------------------
// Seeds — the packages.test.ts rig (real minted PATs through TokenService).
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
}

async function seedUser(username: string, opts: { type?: "user" | "org" } = {}): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: opts.type ?? "user",
      visibility: "public",
      createdAt: NOW,
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin: user.isAdmin });
  return { id: user.id, username: user.username };
}

async function token(userId: number, scopes = "write:package"): Promise<string> {
  return (await mintFor(userId, "pat", scopes)).plaintext;
}

/** One owner-level hook; returns its id. */
async function seedHook(ownerId: number, events: Record<string, unknown>, active = true): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      ownerId,
      url: "https://hooks.example.com/target",
      events: JSON.stringify(events),
      isActive: active,
      type: "gitea",
      createdAt: NOW,
    })
    .returning({ id: webhooks.id })
    .all();
  return rows[0]!.id;
}

/** The PackagePayload shape the emission renders (hook.go:594-606). */
interface EmittedPackagePayload {
  action: string;
  package: {
    id: number;
    owner: { id: number; login: string };
    repository: unknown;
    creator: { id: number; login: string } | null;
    type: string;
    name: string;
    version: string;
    html_url: string;
    created_at: string;
  };
  repository: unknown;
  organization: Record<string, unknown> | null;
  sender: { id: number; login: string };
}

const deliveries = async (): Promise<Array<{ hookId: number; eventType: string; eventGroup: string; payload: EmittedPackagePayload }>> => {
  const rows = await db().select().from(webhookDeliveries).all();
  return rows
    .sort((a, b) => a.id - b.id)
    .map((row) => ({
      hookId: row.hookId,
      eventType: row.eventType,
      eventGroup: row.eventGroup,
      payload: JSON.parse(row.payloadContent) as EmittedPackagePayload,
    }));
};

/** The REAL mount shapes (packages.test.ts): /api/packages protocol sub-app
 *  and the /api/v1 management router under resolveAuth. */
function protocol() {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createPackagesProtocolRouter());
  const boundEnv = { ...env, APP_URL };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://hooks.example${path}`, init), boundEnv);
}

/** The 21-protocol ecosystem router (the npm/terraform arms ride it —
 *  packages-npm.test.ts's mount shape). */
function eco() {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createEcosystemProtocolRouter());
  const boundEnv = { ...env, APP_URL };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://hooks.example${path}`, init), boundEnv);
}

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// The npm publish fixtures (packages-npm.test.ts's rig, trimmed) — a real
// ustar+gzip tarball and the creator.go publish document.
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

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  header.set(encoder.encode(name.slice(0, 100)), 0);
  header.set(encoder.encode("0000644\0"), 100); // mode
  header.set(encoder.encode("0000000\0"), 108); // uid
  header.set(encoder.encode("0000000\0"), 116); // gid
  header.set(encoder.encode(`${size.toString(8).padStart(11, "0")} `), 124); // size
  header.set(encoder.encode("00000000000 "), 136); // mtime
  header.set(encoder.encode("        "), 148); // checksum placeholder (spaces)
  header[156] = 0x30; // '0' regular file
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return header;
}

async function makeTarball(files: Record<string, string>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = encoder.encode(content);
    chunks.push(tarHeader(name, bytes.byteLength));
    chunks.push(bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024)); // two zero blocks close the archive
  const gzipped = new Response(
    new Blob([concatBytes(chunks)]).stream().pipeThrough(new CompressionStream("gzip")),
  );
  return new Uint8Array(await gzipped.arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function publishDocument(name: string, version: string, tarball: Uint8Array): Promise<string> {
  const integrity = `sha512-${toBase64(new Uint8Array(await crypto.subtle.digest("SHA-512", tarball)))}`;
  const doc: Record<string, unknown> = {
    _id: name,
    name,
    description: "a test package",
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        description: "a test package",
        author: { name: "The Author" },
        license: "MIT",
        dist: { integrity },
      },
    },
    _attachments: { [`${name}-${version}.tgz`]: { data: toBase64(tarball), length: tarball.byteLength } },
  };
  return JSON.stringify(doc);
}

function v1Router() {
  const v1 = new OpenAPIHono<ApiEnv>();
  v1.onError(giteaErrorHandler);
  registerPackagesRoutes(v1, createTokenAuthMiddleware(resolver));
  const parent = new Hono<{ Bindings: Env }>();
  parent.use("/api/v1/*", resolveAuth());
  parent.route("/api/v1", v1);
  const boundEnv = { ...env, APP_URL };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://hooks.example${path}`, init), boundEnv);
}

interface SeededUserWithAdmin extends SeededUser {
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUserWithAdmin>();

/** API `User` projection the auth resolver returns (the suites' shape). */
function apiUser(user: SeededUserWithAdmin): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: user.isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

const resolver: AuthResolver = {
  resolveToken(tokenValue) {
    const match = /^u(\d+)$/.exec(tokenValue);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

/** A generic upload with a declared length (workerd hides Content-Length on
 *  constructed Requests — the suites' fixture rule). */
async function putFile(
  owner: string,
  name: string,
  version: string,
  filename: string,
  body: string,
  auth?: string,
): Promise<Response> {
  const caller = protocol();
  return caller(`/api/packages/${owner}/generic/${name}/${version}/${filename}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      ...(auth === undefined ? {} : { Authorization: `token ${auth}` }),
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe("package webhook emissions (GAPS #8)", () => {
  it("the registry add fires created with the exact notifyPackage payload", async () => {
    const owner = await seedUser("alice");
    const hookId = await seedHook(owner.id, { choose_events: true, events: { package: true } });
    // The registry write grant is the OWNER's own (owner-scoped packages
    // have no repo permission ladder for a stranger).
    const auth = await token(owner.id);

    const put = await putFile("alice", "mytool", "1.0.0", "mytool.tar.gz", "bytes-1", auth);
    expect(put.status).toBe(201);
    await put.text();

    const versionRow = (
      await db()
        .select()
        .from(packageVersions)
        .innerJoin(packages, eq(packages.id, packageVersions.packageId))
        .where(and(eq(packages.ownerId, owner.id), eq(packages.lowerName, "mytool")))
        .all()
    )[0];
    expect(versionRow).toBeDefined();
    const pkg = versionRow!.packages;
    const version = versionRow!.package_versions;

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hookId).toBe(hookId);
    expect(rows[0]!.eventType).toBe("package");
    expect(rows[0]!.eventGroup).toBe("package");
    const payload = rows[0]!.payload;
    // PackagePayload (modules/structs/hook.go:594-606) — the full five-field
    // set; notifyPackage leaves the top-level repository null; sender is the
    // uploading owner themself here.
    expect(payload).toMatchObject({
      action: "created",
      package: {
        id: version.id,
        repository: null,
        type: "generic",
        name: "mytool",
        version: "1.0.0",
        html_url: `${APP_URL}/alice/-/packages/generic/mytool/1.0.0`,
        created_at: version.createdUnix.toISOString(),
      },
      repository: null,
      organization: null,
    });
    expect(payload.package.owner).toMatchObject({ id: owner.id, login: "alice" });
    expect(payload.package.creator).toMatchObject({ id: owner.id, login: "alice" });
    expect(payload.sender).toMatchObject({ id: owner.id, login: "alice" });
    // The payload bytes are the compat-frozen 2-space marshal (§2.7).
    const raw = await db().select().from(webhookDeliveries).all();
    expect(raw[0]!.payloadContent).toContain('\n  "action": "created"');
    void pkg;
  });

  it("the version-added arm fires again; a second file on the version stays silent", async () => {
    const owner = await seedUser("alice");
    const auth = await token(owner.id);
    await seedHook(owner.id, { send_everything: true });

    await putFile("alice", "mytool", "1.0.0", "a.tar.gz", "bytes-a", auth);
    await putFile("alice", "mytool", "1.0.0", "b.tar.gz", "bytes-b", auth); // same version, new file
    expect(await deliveries()).toHaveLength(1); // packages.go:131's versionCreated gate

    await putFile("alice", "mytool", "2.0.0", "a.tar.gz", "bytes-c", auth); // version added
    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.payload.action).toBe("created");
    expect(rows[1]!.payload.package.version).toBe("2.0.0");
  });

  it("the file DELETE stays silent while the version survives, fires on the cascade", async () => {
    const owner = await seedUser("alice");
    const auth = await token(owner.id);
    await seedHook(owner.id, { send_everything: true });

    await putFile("alice", "mytool", "1.0.0", "a.tar.gz", "bytes-a", auth);
    await putFile("alice", "mytool", "1.0.0", "b.tar.gz", "bytes-b", auth);
    expect(await deliveries()).toHaveLength(1);

    const caller = protocol();
    const delFirst = await caller(`/api/packages/alice/generic/mytool/1.0.0/a.tar.gz`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delFirst.status).toBe(204);
    expect(await deliveries()).toHaveLength(1); // packages.go:572 — the version went NOWHERE

    const delLast = await caller(`/api/packages/alice/generic/mytool/1.0.0/b.tar.gz`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delLast.status).toBe(204);
    const rows = await deliveries();
    expect(rows).toHaveLength(2); // the cascade fired the deleted arm
    expect(rows[1]!.payload).toEqual(
      expect.objectContaining({ action: "deleted", repository: null, organization: null }),
    );
    expect(rows[1]!.payload.package.version).toBe("1.0.0");
    expect(rows[1]!.payload.sender.login).toBe("alice");
  });

  it("the v1 version DELETE fires deleted; the whole-package DELETE fires one event per version", async () => {
    const owner = await seedUser("alice");
    const auth = await token(owner.id);
    await seedHook(owner.id, { send_everything: true });
    await putFile("alice", "mytool", "1.0.0", "a.tar.gz", "bytes-a", auth);
    await putFile("alice", "mytool", "2.0.0", "a.tar.gz", "bytes-b", auth);
    await putFile("alice", "mytool", "3.0.0", "a.tar.gz", "bytes-c", auth);
    expect(await deliveries()).toHaveLength(3);

    const caller = v1Router();
    const delVersion = await caller(`/api/v1/packages/alice/generic/mytool/3.0.0`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delVersion.status).toBe(204);
    let rows = await deliveries();
    expect(rows).toHaveLength(4); // packages.go:532 — exactly one added
    expect(rows[3]!.payload.action).toBe("deleted");
    expect(rows[3]!.payload.package.version).toBe("3.0.0");

    const delPackage = await caller(`/api/v1/packages/alice/generic/mytool`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delPackage.status).toBe(204);
    rows = await deliveries();
    expect(rows).toHaveLength(6); // packages.go:714 — one PER VERSION (the two survivors)
    expect(rows[4]!.payload.package.version).toBe("1.0.0");
    expect(rows[5]!.payload.package.version).toBe("2.0.0");
    expect(rows[4]!.payload.action).toBe("deleted");
    expect(rows[5]!.payload.action).toBe("deleted");
  });

  it("npm unpublish fires deleted — by tarball exactly one, the whole package one per version", async () => {
    const owner = await seedUser("alice");
    const hookId = await seedHook(owner.id, { send_everything: true });
    const auth = await token(owner.id);
    const tarball = await makeTarball({ "package/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }) });
    const publish = async (name: string, version: string): Promise<void> => {
      const body = await publishDocument(name, version, tarball);
      const res = await eco()(`/api/packages/alice/npm/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          Authorization: `token ${auth}`,
        },
        body,
      });
      expect(res.status).toBe(201);
      await res.text();
    };
    await publish("mytool", "1.0.0");
    await publish("mytool", "2.0.0");
    expect(await deliveries()).toHaveLength(2); // the two created arms

    const caller = eco();
    // npm unpublish BY TARBALL (npm.go:337-350): RemovePackageVersion —
    // notifies ALWAYS (packages.go:532), exactly one event.
    const delVersion = await caller(`/api/packages/alice/npm/mytool/-/mytool-2.0.0.tgz/-rev/1`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delVersion.status).toBe(200);
    await delVersion.text();
    let rows = await deliveries();
    expect(rows).toHaveLength(3);
    expect(rows[2]!.hookId).toBe(hookId);
    expect(rows[2]!.payload.action).toBe("deleted");
    expect(rows[2]!.payload.package.type).toBe("npm");
    expect(rows[2]!.payload.package.version).toBe("2.0.0");

    // npm unpublish WHOLE PACKAGE (npm.go:352-375): RemovePackageVersion
    // PER VERSION (the :368 loop) — one event per surviving version.
    const delPackage = await caller(`/api/packages/alice/npm/mytool/-rev/1`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delPackage.status).toBe(200);
    await delPackage.text();
    rows = await deliveries();
    expect(rows).toHaveLength(4);
    expect(rows[3]!.payload.action).toBe("deleted");
    expect(rows[3]!.payload.package.version).toBe("1.0.0");
  });

  it("chef deletes fire the package webhook: the version arm once, the cookbook arm per version (chef.go:359/:395)", async () => {
    const owner = await seedUser("alice");
    const hookId = await seedHook(owner.id, { send_everything: true });
    const auth = await token(owner.id);
    const caller = eco();
    const cookbook = async (version: string): Promise<Uint8Array> =>
      gzipCompress(
        buildTar(
          [{ name: "test/metadata.json", mode: 0o600, data: new TextEncoder().encode(JSON.stringify({ name: "test", version })) }],
          true,
        ),
      );
    const upload = async (version: string): Promise<void> => {
      const boundary = "chefboundary9182";
      const tarball = await cookbook(version);
      const head = new TextEncoder().encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="tarball"; filename="${version}.tar.gz"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      const body = new Uint8Array(head.byteLength + tarball.byteLength + tail.byteLength);
      body.set(head, 0);
      body.set(tarball, head.byteLength);
      body.set(tail, head.byteLength + tarball.byteLength);
      const res = await caller(`/api/packages/alice/chef/api/v1/cookbooks`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}`, Authorization: `token ${auth}` },
        body,
      });
      expect(res.status).toBe(201);
      await res.text();
    };
    await upload("1.0.1");
    await upload("1.0.2");
    expect(await deliveries()).toHaveLength(2); // the two created arms (one per new version)

    // The version arm (chef.go:359 → RemovePackageVersionByNameAndVersion →
    // packages.go:532 — notifies ALWAYS): exactly one event.
    const delVersion = await caller(`/api/packages/alice/chef/api/v1/cookbooks/test/versions/1.0.1`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delVersion.status).toBe(200);
    await delVersion.text();
    let rows = await deliveries();
    expect(rows).toHaveLength(3);
    expect(rows[2]!.hookId).toBe(hookId);
    expect(rows[2]!.payload.action).toBe("deleted");
    expect(rows[2]!.payload.package.type).toBe("chef");
    expect(rows[2]!.payload.package.version).toBe("1.0.1");
    expect(rows[2]!.payload.sender.login).toBe("alice");

    // The cookbook arm (chef.go:395 — RemovePackageVersion PER VERSION):
    // one event per surviving version.
    const delCookbook = await caller(`/api/packages/alice/chef/api/v1/cookbooks/test`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delCookbook.status).toBe(200);
    await delCookbook.text();
    rows = await deliveries();
    expect(rows).toHaveLength(4);
    expect(rows[3]!.payload.action).toBe("deleted");
    expect(rows[3]!.payload.package.version).toBe("1.0.2");
  });

  it("terraform whole-state delete fires one event per version; the by-serial delete stays silent (terraform.go:233's model-level cascade)", async () => {
    const owner = await seedUser("alice");
    await seedHook(owner.id, { send_everything: true });
    const auth = await token(owner.id);
    const caller = eco();
    const postState = async (serial: number): Promise<Response> =>
      caller(`/api/packages/alice/terraform/state/prod-network`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", Authorization: `token ${auth}` },
        body: encoder.encode(
          JSON.stringify({ version: 4, terraform_version: "1.9.0", serial, lineage: "9b5d3cf1", outputs: {}, resources: [] }),
        ),
      });
    expect((await postState(1)).status).toBe(201);
    expect((await postState(2)).status).toBe(201);
    expect(await deliveries()).toHaveLength(2);

    // DeleteStateBySerial (terraform.go:196-234): the model-level
    // DeletePackageVersionAndReferences cascade — NO PackageDelete upstream.
    const delSerial = await caller(`/api/packages/alice/terraform/state/prod-network/versions/1`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delSerial.status).toBe(204);
    await delSerial.text();
    expect(await deliveries()).toHaveLength(2);

    // DeleteState (terraform.go:238-297): RemovePackageVersion PER VERSION
    // (the :285 loop) — one event per surviving version, then the silent
    // model-level DeletePackageByID.
    const delState = await caller(`/api/packages/alice/terraform/state/prod-network`, {
      method: "DELETE",
      headers: { Authorization: `token ${auth}` },
    });
    expect(delState.status).toBe(200);
    await delState.text();
    const rows = await deliveries();
    expect(rows).toHaveLength(3);
    expect(rows[2]!.payload.action).toBe("deleted");
    expect(rows[2]!.payload.package.type).toBe("terraform");
    expect(rows[2]!.payload.package.version).toBe("2");
  });

  it("inactive hooks and non-package subscriptions stay silent; the owner scope routes", async () => {
    const owner = await seedUser("alice");
    const auth = await token(owner.id);
    const inactive = await seedHook(owner.id, { send_everything: true }, false);
    const pushOnly = await seedHook(owner.id, { choose_events: true, events: { push: true } });
    const pushOnlyFlag = await seedHook(owner.id, { push_only: true });
    const everything = await seedHook(owner.id, { send_everything: true });

    await putFile("alice", "mytool", "1.0.0", "a.tar.gz", "bytes-a", auth);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hookId).toBe(everything);
    expect(rows[0]!.hookId).not.toBe(inactive);
    expect(rows[0]!.hookId).not.toBe(pushOnly);
    expect(rows[0]!.hookId).not.toBe(pushOnlyFlag);
    // The unlinked package's EventSource carries no Repository (upstream
    // webhook.go:207) — the emission's repoId sentinel matches no repo hook
    // and the delivery row routes owner-side.
    const raw = await db().select().from(webhookDeliveries).all();
    expect(raw[0]!.repoId).toBe("");
  });

  it("an org owner renders the organization block (ToOrganization)", async () => {
    const org = await seedUser("acme", { type: "org" });
    const doer = await seedUser("bob");
    await seedHook(org.id, { send_everything: true });
    // The write grant rides the org-membership ladder (owner role).
    await db()
      .insert(orgMembers)
      .values({ orgId: org.id, userId: doer.id, role: "owner", createdAt: NOW })
      .all();
    const auth = await token(doer.id);

    const put = await putFile("acme", "lib", "1.0.0", "lib.tar.gz", "bytes", auth);
    expect(put.status).toBe(201);
    await put.text();

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload;
    expect(payload.organization).toEqual(
      expect.objectContaining({ id: org.id, name: "acme", username: "acme" }),
    );
    expect(payload.package.owner.login).toBe("acme");
    expect(payload.sender.login).toBe("bob");
  });
});
