/**
 * The LFS store config wave (SPEC-0006 §6 as-built — the ledger L14, the
 * former "presign mode is UNREACHABLE in production" record): the
 * `LFS_STORE_PRESIGN` env gate's strict polarity, the fail-closed degrade
 * when the S3 credential triple is incomplete, and the `defaultLfsDeps`
 * production wiring. Upstream posture pin: `ServeDirect()`
 * (`modules/setting/storage.go:49,96-98`) with `server.go:496-503`'s
 * fall-through to the relayed link whenever the direct URL is unavailable —
 * the degrade lineage our capability probe continues.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { defaultLfsDeps } from "../../lfs/router";
import {
  DEFAULT_R2_LFS_BUCKET_NAME,
  createLfsStore,
  lfsStoreConfigFromEnv,
} from "./store";

/** The credential triple in its ENV-VAR spelling (what the gate reads). */
const ENV_TRIPLE = {
  R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
  R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDAG/bJEPyPg5m9mQY2glgvmW",
  R2_ACCOUNT_ID: "abc123def456",
};
/** The same triple as the derived `LfsStoreConfig.credentials` fields. */
const CREDENTIALS = {
  accessKeyId: ENV_TRIPLE.R2_ACCESS_KEY_ID,
  secretAccessKey: ENV_TRIPLE.R2_SECRET_ACCESS_KEY,
  accountId: ENV_TRIPLE.R2_ACCOUNT_ID,
};

describe("lfsStoreConfigFromEnv — LFS_STORE_PRESIGN strict polarity", () => {
  it("arms presign ONLY on the exact string \"true\"", () => {
    expect(lfsStoreConfigFromEnv({ LFS_STORE_PRESIGN: "true" }).mode).toBe("auto");
    // Fail-closed: unset, empty, case variants, truthy-looking strings and
    // whitespace-padded forms all stay relay.
    for (const off of [undefined, "", "false", "False", "True", "TRUE", "1", "yes", "on", " true", "true ", "true\n"]) {
      expect(lfsStoreConfigFromEnv({ LFS_STORE_PRESIGN: off }).mode, `LFS_STORE_PRESIGN=${JSON.stringify(off)}`).toBe(
        "relay",
      );
    }
  });

  it("a closed gate forces relay even with a complete credential triple present", () => {
    // The VAR gates the mode, not the credentials — a deployment that set the
    // secrets but never armed the gate never presigns.
    expect(lfsStoreConfigFromEnv({ LFS_STORE_PRESIGN: "false", ...ENV_TRIPLE })).toEqual({ mode: "relay" });
    expect(lfsStoreConfigFromEnv({})).toEqual({ mode: "relay" });
  });

  it("\"true\" carries the credential triple and the shipped bucket name", () => {
    const config = lfsStoreConfigFromEnv({ LFS_STORE_PRESIGN: "true", ...ENV_TRIPLE });
    expect(config.mode).toBe("auto");
    expect(config.credentials).toEqual(CREDENTIALS);
    expect(config.bucketName).toBe(DEFAULT_R2_LFS_BUCKET_NAME);
  });
});

describe("the env-derived config through createLfsStore", () => {
  it("constructs PresignLfsStore only when the gate is true AND the triple is complete", () => {
    const armed = lfsStoreConfigFromEnv({ LFS_STORE_PRESIGN: "true", ...ENV_TRIPLE });
    expect(createLfsStore(env.REPO_PACKS, armed).mode).toBe("presign");

    // Any missing credential piece degrades to relay — the §2.3 capability
    // probe, never a throw (defaultLfsDeps runs per request, so a
    // half-armed deployment must keep serving the family).
    const partials: (typeof ENV_TRIPLE)[] = [
      { R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_ACCOUNT_ID: "" },
      { ...ENV_TRIPLE, R2_ACCESS_KEY_ID: "" },
      { ...ENV_TRIPLE, R2_SECRET_ACCESS_KEY: "" },
      { ...ENV_TRIPLE, R2_ACCOUNT_ID: "" },
    ];
    for (const partial of partials) {
      const config = lfsStoreConfigFromEnv({ LFS_STORE_PRESIGN: "true", ...partial });
      expect(createLfsStore(env.REPO_PACKS, config).mode, JSON.stringify(partial)).toBe("relay");
    }
  });
});

describe("defaultLfsDeps wiring (the production construction region)", () => {
  it("reads the gate through the env surface — deps store matches the derivation", async () => {
    // `Env` structurally satisfies the all-optional `LfsStoreEnv`, so the
    // wiring holds before AND after the wrangler.jsonc fold regenerates the
    // generated Env: whatever the injected posture, the production
    // constructor and the derivation agree.
    const derived = lfsStoreConfigFromEnv(env);
    const deps = defaultLfsDeps(env);
    expect(deps.store.mode).toBe(derived.mode);

    // Unless a local posture fully arms the gate AND the secrets, the family
    // stays on the relay store — the shipped default (the committed example
    // declares "false"; test envs carry no R2 S3 credentials). The relay
    // store's capability probe answers null on both directions.
    if (deps.store.mode === "relay") {
      const key = `lfs/r_config/${"a".repeat(64)}`;
      await expect(
        deps.store.presignPut({ key, checksumSha256Base64: "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=" }),
      ).resolves.toBeNull();
      await expect(deps.store.presignGet({ key })).resolves.toBeNull();
    }
  });
});
