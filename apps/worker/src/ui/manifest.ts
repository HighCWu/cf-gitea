/**
 * Vite manifest reader for the Tier-2 UI (SPEC-0008 §2.3.4) — replicates
 * upstream `modules/public/manifest.go` over the Workers ASSETS binding.
 *
 * The manifest is deploy-immutable data (hashes change only on re-pin or
 * rebuild), so it is cached for the isolate lifetime. That is NOT the banned
 * "module-level mutable request state" (AGENTS.md) — it varies per deploy,
 * never per request.
 *
 * Failure mode: a missing manifest or missing required entry throws
 * AssetBuildError; the shell maps it to 503 plain text ("UI assets not
 * built — run `pnpm build:assets`"). Git/API routes never pass through here
 * (the assets config and dispatcher own those paths).
 */

/** Manifest entry shape produced by the Gitea frontend's Vite build. */
export interface ManifestEntry {
  file: string;
  /** Entry-point keys of chunks this entry imports (CSS chain). */
  imports?: string[];
  css?: string[];
}

export type UiManifest = Record<string, ManifestEntry>;

/** Required entries the shell cannot render without (SPEC-0008 §2.3.4;
 *  key verified against the real build's manifest 2026-10-24). */
export const REQUIRED_MANIFEST_KEYS = [
  "web_src/js/iife.ts",
  "web_src/js/index.ts",
  "web_src/css/themes/theme-gitea-light.css",
  "web_src/js/user-events.sharedworker.ts",
] as const;

export class AssetBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetBuildError";
  }
}

interface AssetsFetcher {
  fetch(input: RequestInfo): Promise<Response>;
}

let cached: Promise<UiManifest> | null = null;

/** Load (and isolate-cache) the Vite manifest via the ASSETS binding. */
export function loadManifest(assets: AssetsFetcher | undefined, baseUrl: string): Promise<UiManifest> {
  cached ??= (async () => {
    if (assets === undefined) {
      throw new AssetBuildError("UI assets binding not configured (wrangler.jsonc assets block)");
    }
    const url = new URL("/assets/.vite/manifest.json", baseUrl);
    const response = await assets.fetch(new Request(url.toString()));
    if (!response.ok) {
      throw new AssetBuildError(`UI assets not built — run \`pnpm build:assets\` (manifest ${response.status})`);
    }
    const manifest = await response.json<UiManifest>();
    for (const key of REQUIRED_MANIFEST_KEYS) {
      if (manifest[key] === undefined) {
        throw new AssetBuildError(`manifest missing required entry: ${key}`);
      }
    }
    return manifest;
  })();
  return cached;
}

/** Drop the isolate cache (tests / explicit re-pin reload). */
export function resetManifestCache(): void {
  cached = null;
}

/** Manifest key → served URI: `web_src/js/index.ts` → `/assets/js/index.<h8>.js`. */
export function assetURI(manifest: UiManifest, key: string): string {
  const entry = manifest[key];
  if (entry === undefined) {
    throw new AssetBuildError(`manifest missing entry: ${key}`);
  }
  return `/assets/${entry.file}`;
}

/** Transitive CSS links for the given entry keys, deduplicated, import order. */
export function cssLinks(manifest: UiManifest, ...keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (key: string): void => {
    const entry = manifest[key];
    if (entry === undefined) {
      throw new AssetBuildError(`manifest missing entry: ${key}`);
    }
    for (const css of entry.css ?? []) {
      const uri = `/assets/${css}`;
      if (!seen.has(uri)) {
        seen.add(uri);
        out.push(uri);
      }
    }
    for (const imported of entry.imports ?? []) {
      walk(imported);
    }
  };
  for (const key of keys) walk(key);
  return out;
}
