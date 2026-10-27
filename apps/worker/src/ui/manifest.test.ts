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
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
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

  it("preserves ROOT-KEY argument order and dedupes a shared import chain across keys", () => {
    // The determinism contract: the walk order is the caller's key order
    // (secondary first here — the reverse of the single-key walk above), and
    // a css already emitted through one key never re-emits through another.
    expect(cssLinks(manifest, "web_src/js/secondary.ts", "web_src/js/index.ts")).toEqual([
      "/assets/css/secondary.3333cccc.css",
      "/assets/css/index.1111aaaa.css",
    ]);
  });

  it("throws AssetBuildError when an IMPORTED key is missing (the walk's error arm)", () => {
    const broken: UiManifest = {
      ...manifest,
      "web_src/js/secondary.ts": { file: "js/secondary.2222bbbb.js", imports: ["web_src/js/gone.ts"] },
    };
    expect(() => cssLinks(broken, "web_src/js/index.ts")).toThrow(AssetBuildError);
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

  it("deterministically fetches /assets/.vite/manifest.json off the given base URL", async () => {
    // The module's one URL rule: the base URL decides only the fetch target,
    // never the parse result — the same manifest bytes answer from any origin.
    resetManifestCache();
    const seen: string[] = [];
    const spy = {
      fetch: (input: RequestInfo): Promise<Response> => {
        seen.push(input instanceof Request ? input.url : String(input));
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      },
    };
    const loaded = await loadManifest(spy, "https://example.com/");
    expect(seen).toEqual(["https://example.com/assets/.vite/manifest.json"]);
    expect(assetURI(loaded, "web_src/js/index.ts")).toBe("/assets/js/index.deadbeef.js");
    resetManifestCache();
  });

  it("caches a FAILURE too: the poisoned promise rejects every later call until reset", async () => {
    // `cached ??=` holds the PROMISE, so a failed load stays failed for the
    // isolate's lifetime — later calls (even with a healthy ASSETS binding)
    // get the SAME rejection until an explicit reset re-opens the cache.
    resetManifestCache();
    const missing = { fetch: () => Promise.resolve(new Response("not found", { status: 404 })) };
    await expect(loadManifest(missing, "https://example.com/")).rejects.toBeInstanceOf(AssetBuildError);

    const poisoned = loadManifest(okAssets, "https://example.com/");
    await expect(poisoned).rejects.toThrow(/manifest 404/); // the ORIGINAL failure, not a refetch
    resetManifestCache();

    // After the reset the healthy binding answers again.
    const fresh = await loadManifest(okAssets, "https://example.com/");
    expect(assetURI(fresh, "web_src/js/iife.ts")).toBe("/assets/js/iife.abcd1234.js");
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
