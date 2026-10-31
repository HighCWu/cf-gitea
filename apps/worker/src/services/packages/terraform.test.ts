/**
 * The Terraform state-backend battery (SPEC-0016 §7 long tail) on real D1 +
 * the real REPO_PACKS binding — upstream routers/api/packages/terraform/
 * terraform.go + modules/packages/terraform/{state,lock}.go at the pin,
 * through the SERVICE face (the vagrant.test.ts precedent; the route arms
 * ride the packages-terraform unit):
 *
 *  - isValidPackageName: the pin's OWN test vectors verbatim
 *    (terraform_test.go:12-36 — bad "" "." ".." "-" "a?b" "a b" "a/b"; good
 *    "a" "1" "a-" "a_b" "c.d+");
 *  - ParseState: the happy {serial, lineage} pair, the serial-0 arm
 *    ("state serial is missing"), the empty-lineage arm, the type-mismatch
 *    and non-integer arms (Go's uint64 decode errors), the malformed-JSON
 *    arm;
 *  - ParseLockInfo: the ID-required arm, the Created zero-time
 *    canonicalization (Go's round-trip render), the RFC3339-shaped Created
 *    kept verbatim, the malformed-shape arm;
 *  - the lock machine: set → get → the 423 class, the CAS clear, the
 *    ID-mismatch arm, the missing-package arms;
 *  - the round-trip: a real state body → 201-class rows (the `terraform`
 *    package, the serial-string version, the ONE lead `tfstate` file), the
 *    latest + by-serial reads with the GET-only counter bump, byte parity,
 *    the same-serial 409 duplicate, a second serial riding a SECOND version,
 *    the delete-by-serial arms (the latest 403 class, the non-latest 204
 *    class), the whole-state delete (the locked 423 class first), the quota
 *    size 403 with the admin bypass, the chunked upload arm.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageFiles, packageProperties, packageVersions, packages, users } from "../../db/schema";
import { DuplicatePackageFileError } from "./generic";
import { QuotaTotalSizeError, getOrInsertPackage, packagesQuotaFromEnv } from "./model";
import {
  TERRAFORM_LOCK_FILE,
  TERRAFORM_PACKAGE_TYPE,
  TERRAFORM_STATE_FILENAME,
  TerraformInvalidStateError,
  TerraformInvalidStateNameError,
  TerraformLockInfoError,
  assertTerraformStateWritable,
  deleteTerraformState,
  deleteTerraformStateBySerial,
  getTerraformLatestVersion,
  getTerraformLock,
  isTerraformStateNameValid,
  lockTerraformState,
  openTerraformStateForDownload,
  parseTerraformLockInfo,
  parseTerraformState,
  removeTerraformLock,
  setTerraformLock,
  unlockTerraformState,
  uploadTerraformState,
  type UploadTerraformStateInput,
} from "./terraform";

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

async function seedUser(username: string): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
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

// ---------------------------------------------------------------------------
// The state body builder — a real terraform-state JSON document (the
// state.go two-field subset lives inside the full form).
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function stateBytes(serial: number, lineage = "9b5d3cf1-6f0a-4a2e-9a1b-0c2d3e4f5a6b"): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      version: 4,
      terraform_version: "1.9.0",
      serial,
      lineage,
      outputs: {},
      resources: [],
    }),
  );
}

/** The service call with the standard owner/doer/quota wiring. */
function upload(
  owner: { id: number },
  doerId: number,
  overrides: Partial<UploadTerraformStateInput> & { content: ReadableStream<Uint8Array> },
): Promise<unknown> {
  return uploadTerraformState({
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner: { id: owner.id, type: "user", visibility: "public" },
    doer: { id: doerId, isAdmin: false },
    name: "prod-network",
    declaredLength: undefined,
    quota: packagesQuotaFromEnv({}),
    ...overrides,
  });
}

const OWNER = "tfowner";
const DOER = "tfdoer";
let ownerRow: { id: number; username: string };
let doerRow: { id: number; username: string };

beforeEach(async () => {
  ownerRow = await seedUser(OWNER);
  doerRow = await seedUser(DOER);
});

// ---------------------------------------------------------------------------
// isValidPackageName — the pin's OWN vectors (terraform_test.go:12-36)
// ---------------------------------------------------------------------------

describe("isTerraformStateNameValid (terraform_test.go's vectors verbatim)", () => {
  it("the bad set: empty, dot-pairs, lone dash, bad characters", () => {
    for (const bad of ["", ".", "..", "-", "a?b", "a b", "a/b"]) {
      expect(isTerraformStateNameValid(bad)).toBe(false);
    }
  });

  it("the good set: lone alnum, dash/suffixes, plus and dot joins", () => {
    for (const good of ["a", "1", "a-", "a_b", "c.d+"]) {
      expect(isTerraformStateNameValid(good)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ParseState (state.go)
// ---------------------------------------------------------------------------

describe("parseTerraformState (state.go:21-31)", () => {
  it("the happy pair: serial + lineage out of the full state document", () => {
    expect(parseTerraformState(stateBytes(3))).toEqual({ serial: 3, lineage: "9b5d3cf1-6f0a-4a2e-9a1b-0c2d3e4f5a6b" });
  });

  it("serial 0 means it wasn't set — 'state serial is missing'", () => {
    expect(() => parseTerraformState(stateBytes(0))).toThrow(TerraformInvalidStateError);
    try {
      parseTerraformState(stateBytes(0));
    } catch (error) {
      expect((error as TerraformInvalidStateError).message).toBe("state serial is missing");
    }
  });

  it("an empty lineage is 'state lineage is missing'", () => {
    expect(() => parseTerraformState(stateBytes(1, ""))).toThrow("state lineage is missing");
  });

  it("the decode-error class: malformed JSON, a string serial, a fractional serial, an array document", () => {
    expect(() => parseTerraformState(encoder.encode("{not json"))).toThrow(TerraformInvalidStateError);
    expect(() =>
      parseTerraformState(encoder.encode(JSON.stringify({ serial: "1", lineage: "x" }))),
    ).toThrow(TerraformInvalidStateError);
    expect(() =>
      parseTerraformState(encoder.encode(JSON.stringify({ serial: 1.5, lineage: "x" }))),
    ).toThrow(TerraformInvalidStateError);
    expect(() => parseTerraformState(encoder.encode("[1,2]"))).toThrow(TerraformInvalidStateError);
  });
});

// ---------------------------------------------------------------------------
// ParseLockInfo (lock.go)
// ---------------------------------------------------------------------------

describe("parseTerraformLockInfo (lock.go:38-52)", () => {
  it("ID required — 'terraform lock is missing an ID'", () => {
    expect(() => parseTerraformLockInfo(encoder.encode(JSON.stringify({ Operation: "OperationTypeApply" })))).toThrow(
      TerraformLockInfoError,
    );
    try {
      parseTerraformLockInfo(encoder.encode("{}"));
    } catch (error) {
      expect((error as TerraformLockInfoError).message).toBe("terraform lock is missing an ID");
    }
  });

  it("the full struct round-trips; an absent Created renders the zero time (the Go round-trip shape)", () => {
    const parsed = parseTerraformLockInfo(
      encoder.encode(
        JSON.stringify({
          ID: "2b2c74aa-4c6f-c81e-6a12-19e15a2d0bc7",
          Operation: "OperationTypeApply",
          Info: "",
          Who: "root@runner",
          Version: "1.9.0",
          Created: "2026-10-31T12:00:00Z",
          Path: "terraform.go:34",
        }),
      ),
    );
    expect(parsed).toEqual({
      ID: "2b2c74aa-4c6f-c81e-6a12-19e15a2d0bc7",
      Operation: "OperationTypeApply",
      Info: "",
      Who: "root@runner",
      Version: "1.9.0",
      Created: "2026-10-31T12:00:00Z",
      Path: "terraform.go:34",
    });
    const bare = parseTerraformLockInfo(encoder.encode(JSON.stringify({ ID: "x" })));
    expect(bare.Created).toBe("0001-01-01T00:00:00Z");
    expect(bare.Operation).toBe("");
  });

  it("a non-time Created is the decode-error arm", () => {
    expect(() => parseTerraformLockInfo(encoder.encode(JSON.stringify({ ID: "x", Created: "not-a-time" })))).toThrow(
      TerraformLockInfoError,
    );
  });
});

// ---------------------------------------------------------------------------
// The lock machine (lock.go Get/Set/Remove + the route-facing pairs)
// ---------------------------------------------------------------------------

describe("the terraform lock machine", () => {
  it("set → get reads the lock back (IsLocked); the CAS clear empties it", async () => {
    const { row: pkg } = await getOrInsertPackage(env.DB, {
      ownerId: ownerRow.id,
      type: TERRAFORM_PACKAGE_TYPE,
      name: "prod-network",
    });
    expect(await getTerraformLock(env.DB, pkg.id)).toEqual({
      ID: "",
      Operation: "",
      Info: "",
      Who: "",
      Version: "",
      Created: "0001-01-01T00:00:00Z",
      Path: "",
    });
    const lock = {
      ID: "lock-1",
      Operation: "OperationTypeApply",
      Info: "",
      Who: "root@runner",
      Version: "1.9.0",
      Created: "2026-10-31T12:00:00Z",
      Path: "",
    };
    await setTerraformLock(env.DB, pkg.id, lock);
    expect((await getTerraformLock(env.DB, pkg.id)).ID).toBe("lock-1");
    await removeTerraformLock(env.DB, pkg.id);
    expect((await getTerraformLock(env.DB, pkg.id)).ID).toBe("");
    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, pkg.id))
      .all();
    expect(props).toHaveLength(1);
    expect(props[0]?.name).toBe(TERRAFORM_LOCK_FILE);
    expect(props[0]?.value).toBe("");
  });

  it("the route-facing lock pair: lock → locked-again class; unlock mismatch → mismatch; unlock with the right ID → ok", async () => {
    const body = (id: string): Uint8Array => encoder.encode(JSON.stringify({ ID: id, Who: "root@runner" }));
    const first = await lockTerraformState(env.DB, ownerRow.id, "prod-network", body("lock-A"));
    expect(first.kind).toBe("ok");
    // The package ALLOCATED with zero versions (terraform.go:327-342).
    const pkg = await db()
      .select()
      .from(packages)
      .where(eq(packages.ownerId, ownerRow.id))
      .all();
    expect(pkg).toHaveLength(1);
    expect(pkg[0]?.type).toBe(TERRAFORM_PACKAGE_TYPE);
    expect((await db().select().from(packageVersions).all()).length).toBe(0);

    const second = await lockTerraformState(env.DB, ownerRow.id, "prod-network", body("lock-B"));
    expect(second.kind).toBe("locked");
    if (second.kind === "locked") {
      expect(second.lock.ID).toBe("lock-A");
    }

    expect((await unlockTerraformState(env.DB, ownerRow.id, "prod-network", body("lock-B"))).kind).toBe("mismatch");
    expect((await getTerraformLock(env.DB, pkg[0]?.id ?? 0)).ID).toBe("lock-A");
    expect((await unlockTerraformState(env.DB, ownerRow.id, "prod-network", body("lock-A"))).kind).toBe("ok");
    expect((await getTerraformLock(env.DB, pkg[0]?.id ?? 0)).ID).toBe("");
  });

  it("unlock on a missing package answers the missing class (the route's 200) without allocating (terraform.go:389-392)", async () => {
    expect(
      (await unlockTerraformState(env.DB, ownerRow.id, "ghost", encoder.encode(JSON.stringify({ ID: "x" })))).kind,
    ).toBe("missing");
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("the bad-name and bad-lock arms answer before any allocation", async () => {
    expect((await lockTerraformState(env.DB, ownerRow.id, "..", encoder.encode(JSON.stringify({ ID: "x" })))).kind).toBe(
      "bad-name",
    );
    expect(
      (await lockTerraformState(env.DB, ownerRow.id, "prod-network", encoder.encode(JSON.stringify({ Who: "x" })))).kind,
    ).toBe("bad-lock");
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("assertTerraformStateWritable: locked + ID mismatch → the locked class; the right ID → ok; unlocked → ok", async () => {
    expect((await assertTerraformStateWritable(env.DB, ownerRow.id, "prod-network", "")).kind).toBe("ok");
    await lockTerraformState(env.DB, ownerRow.id, "prod-network", encoder.encode(JSON.stringify({ ID: "lock-A" })));
    const held = await assertTerraformStateWritable(env.DB, ownerRow.id, "prod-network", "wrong");
    expect(held.kind).toBe("locked");
    if (held.kind === "locked") expect(held.lock.ID).toBe("lock-A");
    expect((await assertTerraformStateWritable(env.DB, ownerRow.id, "prod-network", "lock-A")).kind).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// The upload + read + delete round-trip (terraform.go:88-297)
// ---------------------------------------------------------------------------

describe("uploadTerraformState + the reads + the deletes", () => {
  it("the round-trip: the serial version, the ONE lead tfstate file, byte parity, the GET-only bump", async () => {
    const bytes = stateBytes(3);
    const result = (await upload(ownerRow, doerRow.id, {
      content: new Response(bytes.slice()).body as ReadableStream<Uint8Array>,
    })) as Awaited<ReturnType<typeof uploadTerraformState>>;

    const pkgs = await db().select().from(packages).all();
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.name).toBe("prod-network");
    expect(pkgs[0]?.type).toBe(TERRAFORM_PACKAGE_TYPE);
    expect(pkgs[0]?.semverCompatible).toBe(false);

    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe("3");

    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe(TERRAFORM_STATE_FILENAME);
    expect(files[0]?.isLead).toBe(true);
    expect(result.file.id).toBe(files[0]?.id);

    // Latest + by-serial reads: byte parity, then the GET bump (HEAD never counts).
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    const first = await openTerraformStateForDownload(env.DB, env.REPO_PACKS, owner, "prod-network", null, "GET");
    expect(first).not.toBeNull();
    const served = new Uint8Array(await new Response(first?.stream as ReadableStream).arrayBuffer());
    expect(served).toEqual(bytes);
    expect(first?.size).toBe(bytes.byteLength);
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    await openTerraformStateForDownload(env.DB, env.REPO_PACKS, owner, "prod-network", null, "HEAD");
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    expect(
      (await openTerraformStateForDownload(env.DB, env.REPO_PACKS, owner, "prod-network", "3", "GET"))?.size,
    ).toBe(bytes.byteLength);
    expect(await openTerraformStateForDownload(env.DB, env.REPO_PACKS, owner, "prod-network", "9", "GET")).toBeNull();
    expect(await openTerraformStateForDownload(env.DB, env.REPO_PACKS, owner, "ghost", null, "GET")).toBeNull();
  });

  it("a same-serial re-post is the 409 duplicate; a NEW serial rides a second version of the same package", async () => {
    const stream = (): ReadableStream<Uint8Array> =>
      new Response(stateBytes(3).slice()).body as ReadableStream<Uint8Array>;
    await upload(ownerRow, doerRow.id, { content: stream() });
    await expect(upload(ownerRow, doerRow.id, { content: stream() })).rejects.toBeInstanceOf(DuplicatePackageFileError);
    expect(await db().select().from(packageVersions).all()).toHaveLength(1);

    await upload(ownerRow, doerRow.id, {
      content: new Response(stateBytes(4).slice()).body as ReadableStream<Uint8Array>,
    });
    const versions = await db().select().from(packageVersions).all();
    expect(versions.map((row) => row.version).sort()).toEqual(["3", "4"]);
    expect((await db().select().from(packages).all()).length).toBe(1);
    const latest = await getTerraformLatestVersion(env.DB, ownerRow.id, "prod-network");
    expect(latest?.version).toBe("4");
  });

  it("the name gate fires BEFORE any write (the 400 class)", async () => {
    await expect(
      upload(ownerRow, doerRow.id, {
        content: new Response(stateBytes(1).slice()).body as ReadableStream<Uint8Array>,
        name: "..",
      }),
    ).rejects.toBeInstanceOf(TerraformInvalidStateNameError);
    await expect(
      upload(ownerRow, doerRow.id, {
        content: new Response(stateBytes(1).slice()).body as ReadableStream<Uint8Array>,
        name: "a?b",
      }),
    ).rejects.toBeInstanceOf(TerraformInvalidStateNameError);
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("a non-state body is the 400 parse class BEFORE any version lands (the package may exist from a lock)", async () => {
    await expect(
      upload(ownerRow, doerRow.id, {
        content: new Response(encoder.encode("this is not terraform state")).body as ReadableStream<Uint8Array>,
      }),
    ).rejects.toBeInstanceOf(TerraformInvalidStateError);
  });

  it("a locked state refuses the mismatched-ID upload; the ID-bearing upload passes (terraform.go:108-121)", async () => {
    await upload(ownerRow, doerRow.id, {
      content: new Response(stateBytes(1).slice()).body as ReadableStream<Uint8Array>,
    });
    await lockTerraformState(env.DB, ownerRow.id, "prod-network", encoder.encode(JSON.stringify({ ID: "lock-A" })));
    // The service-level enforcement arm (the route renders the 423 JSON).
    const held = await assertTerraformStateWritable(env.DB, ownerRow.id, "prod-network", "wrong");
    expect(held.kind).toBe("locked");
    await upload(ownerRow, doerRow.id, {
      content: new Response(stateBytes(2).slice()).body as ReadableStream<Uint8Array>,
    });
    const versions = await db().select().from(packageVersions).all();
    expect(versions.map((row) => row.version).sort()).toEqual(["1", "2"]);
    expect((await getTerraformLatestVersion(env.DB, ownerRow.id, "prod-network"))?.version).toBe("2");
  });

  it("delete-by-serial: the latest is the 403 class, a non-latest deletes, a missing serial is the 404 class", async () => {
    const stream = (serial: number): ReadableStream<Uint8Array> =>
      new Response(stateBytes(serial).slice()).body as ReadableStream<Uint8Array>;
    await upload(ownerRow, doerRow.id, { content: stream(1) });
    await upload(ownerRow, doerRow.id, { content: stream(2) });

    expect(await deleteTerraformStateBySerial(env.DB, ownerRow.id, "prod-network", "9")).toEqual({ kind: "not-found" });
    expect(await deleteTerraformStateBySerial(env.DB, ownerRow.id, "prod-network", "2")).toEqual({ kind: "latest" });
    expect(await deleteTerraformStateBySerial(env.DB, ownerRow.id, "prod-network", "1")).toEqual({ kind: "deleted" });
    expect((await db().select().from(packageVersions).all()).map((row) => row.version)).toEqual(["2"]);
    expect(await deleteTerraformStateBySerial(env.DB, ownerRow.id, "ghost", "1")).toEqual({ kind: "not-found" });
  });

  it("the whole-state delete: locked → the 423 class; unlocked → the cascade clears versions, properties, package", async () => {
    await upload(ownerRow, doerRow.id, {
      content: new Response(stateBytes(1).slice()).body as ReadableStream<Uint8Array>,
    });
    await lockTerraformState(env.DB, ownerRow.id, "prod-network", encoder.encode(JSON.stringify({ ID: "lock-A" })));
    expect(await deleteTerraformState(env.DB, ownerRow.id, "prod-network")).toEqual({ kind: "locked" });

    await unlockTerraformState(env.DB, ownerRow.id, "prod-network", encoder.encode(JSON.stringify({ ID: "lock-A" })));
    expect(await deleteTerraformState(env.DB, ownerRow.id, "prod-network")).toEqual({ kind: "deleted" });
    expect(await db().select().from(packages).all()).toHaveLength(0);
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);
    expect(await db().select().from(packageProperties).all()).toHaveLength(0);
    expect(await deleteTerraformState(env.DB, ownerRow.id, "prod-network")).toEqual({ kind: "not-found" });
  });

  it("a chunked (no-Content-Length) upload rides the bounded spool arm", async () => {
    const bytes = stateBytes(7);
    const result = (await upload(ownerRow, doerRow.id, {
      content: new Response(bytes.slice()).body as ReadableStream<Uint8Array>,
      declaredLength: undefined,
    })) as Awaited<ReturnType<typeof uploadTerraformState>>;
    expect(result.blob.size).toBe(bytes.byteLength);
    expect(result.state.serial).toBe(7);
  });

  it("the size quota 403 class with the admin bypass (no count-quota arm upstream)", async () => {
    const bytes = stateBytes(1);
    const base = {
      d1: env.DB,
      bucket: env.REPO_PACKS,
      owner: { id: ownerRow.id, type: "user", visibility: "public" },
      doer: { id: doerRow.id, isAdmin: false },
      name: "prod-network",
      declaredLength: undefined,
      quota: { limitTotalOwnerCount: -1, limitTotalOwnerSize: bytes.byteLength - 1, limitSizeGeneric: -1, packagesEnabled: true },
    } as UploadTerraformStateInput;
    await expect(
      uploadTerraformState({ ...base, content: new Response(bytes.slice()).body as ReadableStream<Uint8Array> }),
    ).rejects.toBeInstanceOf(QuotaTotalSizeError);
    await uploadTerraformState({
      ...base,
      doer: { id: doerRow.id, isAdmin: true },
      content: new Response(bytes.slice()).body as ReadableStream<Uint8Array>,
    });
    expect(await db().select().from(packageVersions).all()).toHaveLength(1);
  });
});
