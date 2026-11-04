/**
 * The instance-key AEAD envelope suite (census B-57, the A14 at-rest arm):
 * the v1 envelope's crypto pins (round-trip, fresh IV, tamper-fails, the
 * version dispatch incl. the legacy-plaintext arm), the SHARED key home
 * (the `general_token_signing_secret` system_keystore row — the Actions
 * keystore's own row, both consumers converge), the operator-only rotation
 * shape, and the at-rest pins THROUGH the real arms — the writer
 * (api/services/secrets-variables.ts createOrUpdateSecret stores the
 * envelope, never plaintext) and the reader (dispatch.ts getSecretsOfTask
 * decrypts, serves legacy rows transparently, and SKIPS an unopenable
 * envelope — upstream's log-and-continue, models/secret/secret.go:180-185).
 *
 * The wire-invisibility proof lives by construction: the 60-test
 * api/routes/secrets-variables.test.ts battery is byte-identical across
 * this change (the Secret wire shape never carries data).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { repoUnits, repositories, secrets, systemKeystore, users } from "../db/schema";
import { createOrUpdateSecret, ownerScope, repoScope, toApiSecret } from "../api/services/secrets-variables";
import { createRunner, insertActionRun } from "./actions/model";
import { fetchTask } from "./actions/dispatch";
import { KEYSTORE_SECRET_ROW, createAuthorizationToken } from "./actions/secrets";
import {
  INSTANCE_ENVELOPE_PREFIX,
  decryptInstanceSecretData,
  encryptInstanceSecretData,
  resetInstanceKeyCacheForTests,
} from "./instance-key";

beforeEach(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // Per-test storage isolation discards the schema, so re-apply every test;
  // the keystore rows are THIS file's state (the actions/secrets.test.ts
  // convention) and every test controls its own cold/warm cache boundary.
  for (const table of [
    "action_runners",
    "action_runner_tokens",
    "action_runs",
    "action_run_jobs",
    "action_run_attempts",
    "action_tasks",
    "action_task_steps",
    "action_task_outputs",
    "action_tasks_versions",
    "secrets",
    "repo_units",
    "repositories",
    "users",
    "system_keystore",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  resetInstanceKeyCacheForTests();
});

const db = () => drizzle(env.DB);

async function rawSecretData(id: number): Promise<string> {
  const row = await db().select().from(secrets).where(eq(secrets.id, id)).get();
  if (row === undefined) throw new Error(`secrets row ${id} vanished`);
  return row.data;
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function flipByte(encoded: string, position: number): string {
  const bytes = base64UrlDecode(encoded);
  const target = bytes[position];
  if (target === undefined) throw new Error(`flipByte: position ${position} out of range`);
  bytes[position] = target ^ 0x01;
  return base64UrlEncode(bytes);
}

describe("the v1 envelope (encrypt/decrypt arms)", () => {
  it("round-trips ascii, unicode, and the empty string", async () => {
    for (const plaintext of ["s3cr3t", "pässwörd-🔑", "line1\nline2", ""]) {
      const sealed = await encryptInstanceSecretData(env.DB, plaintext);
      expect(sealed.startsWith(INSTANCE_ENVELOPE_PREFIX)).toBe(true);
      expect(await decryptInstanceSecretData(env.DB, sealed)).toBe(plaintext);
    }
  });

  it("seals each value under a fresh IV — two seals of the same plaintext differ", async () => {
    const a = await encryptInstanceSecretData(env.DB, "same-input");
    const b = await encryptInstanceSecretData(env.DB, "same-input");
    expect(a).not.toBe(b);
    expect(await decryptInstanceSecretData(env.DB, a)).toBe("same-input");
    expect(await decryptInstanceSecretData(env.DB, b)).toBe("same-input");
  });

  it("fails the tamper pin: flipping a ciphertext byte (or the tag) rejects the open", async () => {
    const sealed = await encryptInstanceSecretData(env.DB, "s3cr3t");
    const payload = sealed.slice(INSTANCE_ENVELOPE_PREFIX.length);
    const bytes = base64UrlDecode(payload);
    // The wire is iv (12) || ciphertext||tag; flip a body byte and a tag byte.
    for (const position of [13, bytes.length - 1]) {
      const tampered = INSTANCE_ENVELOPE_PREFIX + flipByte(payload, position);
      await expect(decryptInstanceSecretData(env.DB, tampered)).rejects.toThrow(/failed to open/);
    }
    // The untouched envelope still opens.
    expect(await decryptInstanceSecretData(env.DB, sealed)).toBe("s3cr3t");
  });

  it("dispatches the legacy arm: a value without the v1 prefix is plaintext, served as-is", async () => {
    expect(await decryptInstanceSecretData(env.DB, "plain-legacy-value")).toBe("plain-legacy-value");
    expect(await decryptInstanceSecretData(env.DB, "")).toBe("");
  });

  it("fails closed on malformed and unknown-version envelopes", async () => {
    // Below the floor gate (iv + tag alone).
    await expect(decryptInstanceSecretData(env.DB, "v1:AAAA")).rejects.toThrow(/floor gate/);
    // Not valid base64url at all.
    await expect(decryptInstanceSecretData(env.DB, "v1:!!!!")).rejects.toThrow(/floor gate/);
    // A future version prefix must not silently misread.
    await expect(decryptInstanceSecretData(env.DB, "v9:AAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow(/unknown envelope version/);
  });

  it("uses the SHARED keystore row: the first seal generates general_token_signing_secret, the Actions consumer converges on it", async () => {
    const before = await db().select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
    expect(before).toBeUndefined();
    await encryptInstanceSecretData(env.DB, "s3cr3t");
    const row = await db().select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
    expect(row).toBeDefined();
    // The row spelling is the Actions keystore's SecretPiece (services/
    // actions/secrets.ts): the two consumers share the material.
    const piece = JSON.parse(row!.value) as { v: number; tokenSigningSecret: string };
    expect(piece.v).toBe(1);
    expect(piece.tokenSigningSecret).toMatch(/^[0-9a-f]{64}$/);
    // The Actions keystore loader reads the SAME row and mints a runtime
    // token with it — the convergence pin (no second row, no conflict).
    const token = await createAuthorizationToken(env, 1, 1, 1);
    expect(token.split(".")).toHaveLength(3);
  });

  it("operator-only rotation: replacing the row + an isolate restart invalidates old envelopes; new writes open", async () => {
    const sealed = await encryptInstanceSecretData(env.DB, "under-old-key");
    // The operator arm: swap the material out-of-band (wrangler d1 execute's
    // role), then restart (the TEST-ONLY cache drop).
    const freshBytes = crypto.getRandomValues(new Uint8Array(32));
    let freshHex = "";
    for (const b of freshBytes) freshHex += b.toString(16).padStart(2, "0");
    await db()
      .update(systemKeystore)
      .set({ value: JSON.stringify({ v: 1, tokenSigningSecret: freshHex }) })
      .where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW));
    resetInstanceKeyCacheForTests();
    // The old envelope now fails to open (the reader's skip arm engages)…
    await expect(decryptInstanceSecretData(env.DB, sealed)).rejects.toThrow(/failed to open/);
    // …and new writes/read work under the rotated key.
    const resealed = await encryptInstanceSecretData(env.DB, "under-new-key");
    expect(await decryptInstanceSecretData(env.DB, resealed)).toBe("under-new-key");
  });
});

describe("the writer arm (createOrUpdateSecret stores the envelope)", () => {
  it("the INSERT arm stores a v1 envelope, not plaintext — the at-rest pin", async () => {
    const { row } = await createOrUpdateSecret(env.DB, repoScope("repo-x"), "deploy_key", "s3cr3t-plaintext", "ci key");
    const atRest = await rawSecretData(row.id);
    expect(atRest.startsWith(INSTANCE_ENVELOPE_PREFIX)).toBe(true);
    expect(atRest).not.toContain("s3cr3t-plaintext");
    expect(await decryptInstanceSecretData(env.DB, atRest)).toBe("s3cr3t-plaintext");
    // Description behavior is untouched.
    expect(row.description).toBe("ci key");
  });

  it("the UPDATE arm rewrites the envelope (the legacy row's upgrade-on-write)", async () => {
    const scope = repoScope("repo-x");
    const first = await createOrUpdateSecret(env.DB, scope, "deploy_key", "seed-value", "d1");
    // Plant a LEGACY plaintext row (a pre-change deployment's shape).
    await db()
      .update(secrets)
      .set({ data: "legacy-plaintext" })
      .where(eq(secrets.id, first.row.id));
    const second = await createOrUpdateSecret(env.DB, scope, "deploy_key", "v2-value", "d2");
    expect(second.created).toBe(false);
    const atRest = await rawSecretData(first.row.id);
    expect(atRest.startsWith(INSTANCE_ENVELOPE_PREFIX)).toBe(true);
    expect(atRest).not.toContain("legacy-plaintext");
    expect(atRest).not.toContain("v2-value");
    expect(await decryptInstanceSecretData(env.DB, atRest)).toBe("v2-value");
    expect(second.row.description).toBe("d2");
  });

  it("the wire Secret still never carries data (the wire-invisible pin)", async () => {
    const { row } = await createOrUpdateSecret(env.DB, ownerScope(7), "org_key", "s3cr3t", "d");
    const wire = toApiSecret(row);
    expect(Object.keys(wire).sort()).toEqual(["created_at", "description", "name"]);
    expect(JSON.stringify(wire)).not.toContain("s3cr3t");
    expect(JSON.stringify(wire)).not.toContain(INSTANCE_ENVELOPE_PREFIX);
  });
});

describe("the reader arm (getSecretsOfTask decrypts)", () => {
  const PAYLOAD = new TextEncoder().encode("name: ci\njobs:\n  build:\n    steps:\n      - run: echo\n");

  async function seed(): Promise<{ ownerId: number; runner: Awaited<ReturnType<typeof createRunner>> }> {
    const ownerRows = await db()
      .insert(users)
      .values({
        username: "disp",
        usernameLower: "disp",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning({ id: users.id });
    const ownerSeed = ownerRows[0];
    if (ownerSeed === undefined) throw new Error("seed failed");
    const ownerId = ownerSeed.id;
    await db().insert(repositories).values({
      id: "repo-disp",
      storageKey: "r_repo-disp",
      ownerNamespace: "disp",
      ownerId,
      slug: "repo",
      visibility: "public",
    });
    await db().insert(repoUnits).values({ repoId: "repo-disp", type: "actions" });
    await insertActionRun(
      env.DB,
      {
        repoId: "repo-disp",
        ownerId,
        workflowId: "ci.yml",
        index: 1,
        triggerUserId: ownerId,
        ref: "refs/heads/main",
        commitSha: "c".repeat(40),
        event: "pull_request",
        eventPayload: JSON.stringify({
          number: 7,
          pull_request: { base: { ref: "main", sha: "d".repeat(40) }, head: { ref: "feature", sha: "e".repeat(40) } },
        }),
        triggerEvent: "pull_request",
      },
      [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: PAYLOAD }],
    );
    const runner = await createRunner(env.DB, {
      uuid: crypto.randomUUID(),
      name: "disp-runner",
      version: "v1",
      ownerId: 0,
      repoId: "repo-disp",
      agentLabels: ["ubuntu-latest"],
      ephemeral: false,
      hasCancellingSupport: false,
    });
    return { ownerId, runner };
  }

  it("serves an enveloped repo secret and a LEGACY plaintext owner secret; repo overlays owner", async () => {
    const { ownerId, runner } = await seed();
    const now = new Date();
    await db().insert(secrets).values([
      { ownerId, repoId: "", name: "OWNER_LEGACY", data: "owner-legacy-plaintext", description: "", createdAt: now },
      { ownerId: 0, repoId: "repo-disp", name: "REPO_ENV", data: await encryptInstanceSecretData(env.DB, "repo-envelope-value"), description: "", createdAt: now },
    ]);
    const response = await fetchTask(env, env.DB, runner, 0, "https://example.com/");
    const task = response.task;
    expect(task).toBeDefined();
    const secretsOut = (task as NonNullable<typeof task>).secrets;
    // The legacy owner row serves through the transparent plaintext arm…
    expect(secretsOut["OWNER_LEGACY"]).toBe("owner-legacy-plaintext");
    // …and the enveloped repo row serves DECRYPTED (no envelope on the wire
    // to the runner — upstream serves the plaintext value, secret.go:180-185).
    expect(secretsOut["REPO_ENV"]).toBe("repo-envelope-value");
    expect(Object.values(secretsOut).some((v) => v.includes(INSTANCE_ENVELOPE_PREFIX))).toBe(false);
  });

  it("skips an envelope that fails to open (upstream's log-and-continue arm)", async () => {
    const { runner } = await seed();
    const now = new Date();
    const goodSealed = await encryptInstanceSecretData(env.DB, "good-value");
    const tampered = INSTANCE_ENVELOPE_PREFIX + flipByte(goodSealed.slice(INSTANCE_ENVELOPE_PREFIX.length), 13);
    await db().insert(secrets).values([
      { ownerId: 0, repoId: "repo-disp", name: "GOOD", data: goodSealed, description: "", createdAt: now },
      { ownerId: 0, repoId: "repo-disp", name: "BROKEN", data: tampered, description: "", createdAt: now },
    ]);
    const response = await fetchTask(env, env.DB, runner, 0, "https://example.com/");
    const task = response.task;
    expect(task).toBeDefined();
    const secretsOut = (task as NonNullable<typeof task>).secrets;
    expect(secretsOut["GOOD"]).toBe("good-value");
    expect(secretsOut["BROKEN"]).toBeUndefined();
  });
});
