import { describe, expect, it } from "vitest";

import {
  AssetBuildError,
  assetURI,
  cssLinks,
  loadManifest,
  REQUIRED_MANIFEST_KEYS,
  resetManifestCache,
  type UiManifest,
} from "./manifest";

/** Synthetic manifest shaped like the real Vite output (deterministic — the
 *  real build is gitignored, so tests never depend on `pnpm build:assets`). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": {
    file: "js/index.deadbeef.js",
    imports: ["web_src/js/secondary.ts"],
    css: ["css/index.1111aaaa.css"],
  },
  "web_src/js/secondary.ts": {
    file: "js/secondary.2222bbbb.js",
    css: ["css/secondary.3333cccc.css"],
  },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/features/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const okAssets = { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) };

describe("assetURI", () => {
  it("maps a manifest key to the served URI", () => {
    expect(assetURI(manifest, "web_src/js/index.ts")).toBe("/assets/js/index.deadbeef.js");
  });

  it("throws AssetBuildError on a missing key", () => {
    expect(() => assetURI(manifest, "nope.ts")).toThrow(AssetBuildError);
  });
});

describe("cssLinks", () => {
  it("walks imports transitively, deduplicated, in import order", () => {
    expect(cssLinks(manifest, "web_src/js/index.ts")).toEqual([
      "/assets/css/index.1111aaaa.css",
      "/assets/css/secondary.3333cccc.css",
    ]);
  });

  it("is stable across repeated keys", () => {
    expect(cssLinks(manifest, "web_src/js/index.ts", "web_src/js/index.ts")).toHaveLength(2);
  });
});

describe("loadManifest", () => {
  it("caches per isolate and returns the parsed manifest", async () => {
    resetManifestCache();
    const first = await loadManifest(okAssets, "https://example.com/");
    const second = await loadManifest(undefined, "https://example.com/");
    expect(second).toBe(first);
    expect(assetURI(first, "web_src/js/iife.ts")).toBe("/assets/js/iife.abcd1234.js");
    resetManifestCache();
  });

  it("fails fast when the ASSETS binding is absent", async () => {
    resetManifestCache();
    await expect(loadManifest(undefined, "https://example.com/")).rejects.toBeInstanceOf(AssetBuildError);    resetManifestCache();
  });

  it("fails fast on a missing required entry", async () => {
    resetManifestCache();
    const broken = { ...manifest };
    delete broken["web_src/js/iife.ts"];
    const bad = { fetch: () => Promise.resolve(new Response(JSON.stringify(broken), { status: 200 })) };
    await expect(loadManifest(bad, "https://example.com/")).rejects.toThrow(/iife\.ts/);
    resetManifestCache();
  });

  it("fails fast on a non-200 manifest fetch", async () => {
    resetManifestCache();
    const missing = { fetch: () => Promise.resolve(new Response("not found", { status: 404 })) };
    await expect(loadManifest(missing, "https://example.com/")).rejects.toThrow(/build:assets/);
    resetManifestCache();
  });
});

describe("required keys", () => {
  it("covers the four shell-critical entries", () => {
    expect(REQUIRED_MANIFEST_KEYS).toHaveLength(4);
    for (const key of REQUIRED_MANIFEST_KEYS) {
      expect(manifest[key]).toBeDefined();
    }
  });
});
