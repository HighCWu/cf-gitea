/**
 * Deploy-token verification on real D1 — the upstream VerifyDeployKeyToken
 * port (models/deploykey/deploykey_token.go:64-76) the git-HTTP gate's Basic
 * ladder consumes. Pins: the `gdt_` prefix fast-fail ("spares a query for
 * every password of a normal user"), the sha256 + key_type=2 lookup, the
 * repo-scoped row shape (repo_id + mode 1|2), and the throttled
 * UpdateDeployKeyLastUsed touch over `updated_unix` (the HasUsed gate).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import {
  DEPLOY_TOKEN_PREFIX,
  needsDeployKeyLastUsedTouch,
  touchDeployKeyLastUsed,
  verifyDeployToken,
} from "./deploy-token-service";
import { LAST_USED_THROTTLE_MS } from "./token-service";
import { deployKeys } from "../db/schema";
import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";

beforeAll(applyAuthD1Migrations);
beforeEach(async () => {
  // No FK on deploy_keys.repo_id (the repo-scoped-table convention), so the
  // rows seed without a repositories row and sweep alone.
  await env.DB.prepare("DELETE FROM deploy_keys").run();
});

const db = () => drizzle(env.DB);

/** addDeployKeyToken's row shape without importing the API service (this
 *  suite pins the AUTH side; the API family has its own suite). */
async function seedTokenRow(options: { repoId: string; readOnly: boolean; token?: string }) {
  const token = options.token ?? `${DEPLOY_TOKEN_PREFIX}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = new Date();
  await db().insert(deployKeys).values({
    keyId: 0,
    repoId: options.repoId,
    name: "deploy",
    keyType: 2,
    fingerprint: `${token.slice(0, 6)}********${token.slice(-2)}`,
    tokenHash,
    mode: options.readOnly ? 1 : 2,
    createdAt: now,
    updatedAt: now,
  });
  return { token };
}

describe("verifyDeployToken (VerifyDeployKeyToken)", () => {
  it("resolves a seeded token to its repo-scoped row", async () => {
    const { token } = await seedTokenRow({ repoId: "r_1", readOnly: true });
    const key = await verifyDeployToken(env.DB, token);
    expect(key).not.toBeNull();
    expect(key?.repoId).toBe("r_1");
    expect(key?.mode).toBe(1);
  });

  it("carries the write mode through", async () => {
    const { token } = await seedTokenRow({ repoId: "r_2", readOnly: false });
    expect((await verifyDeployToken(env.DB, token))?.mode).toBe(2);
  });

  it("fast-fails a non-gdt_ candidate (a user password or access token)", async () => {
    await seedTokenRow({ repoId: "r_3", readOnly: true });
    expect(await verifyDeployToken(env.DB, "hunter2")).toBeNull();
    expect(await verifyDeployToken(env.DB, "cfg_0123abcd_ABCDEFGHJKLMNPQRSTUVWXYZ234567")).toBeNull();
    expect(await verifyDeployToken(env.DB, "")).toBeNull();
  });

  it("misses an unknown gdt_ value", async () => {
    await seedTokenRow({ repoId: "r_4", readOnly: true });
    expect(await verifyDeployToken(env.DB, `${DEPLOY_TOKEN_PREFIX}${"x".repeat(43)}`)).toBeNull();
  });

  it("never matches an ssh row (key_type guard; ssh rows carry tokenHash '')", async () => {
    const now = new Date();
    await db().insert(deployKeys).values({
      keyId: 7,
      repoId: "r_5",
      name: "ssh key",
      keyType: 1,
      fingerprint: "SHA256:abc",
      tokenHash: "",
      mode: 1,
      createdAt: now,
      updatedAt: now,
    });
    // sha256("") rows must not authenticate — the empty-hash arm is the
    // reason the lookup pins key_type = token.
    const empty = await verifyDeployToken(env.DB, "");
    expect(empty).toBeNull();
  });
});

describe("last-used touch (UpdateDeployKeyLastUsed, throttled)", () => {
  it("reports a fresh row as untouched and moves the stamp past the throttle", async () => {
    const { token } = await seedTokenRow({ repoId: "r_6", readOnly: true });
    const key = (await verifyDeployToken(env.DB, token))!;
    // Whole-second base: `updated_unix` is a mode:"timestamp" column (unix
    // seconds — the schema.ts convention), so a ms-precise date would not
    // round-trip and the exact touch assertion below would false-fail.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    expect(needsDeployKeyLastUsedTouch(key, now)).toBe(false);

    const later = new Date(now.getTime() + LAST_USED_THROTTLE_MS);
    expect(needsDeployKeyLastUsedTouch(key, later)).toBe(true);

    await touchDeployKeyLastUsed(env.DB, key.id, later);
    const touched = (await verifyDeployToken(env.DB, token))!;
    expect(touched.updatedAt.getTime()).toBe(later.getTime());
    expect(needsDeployKeyLastUsedTouch(touched, now)).toBe(false);
  });
});
