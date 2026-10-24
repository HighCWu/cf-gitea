/**
 * Shared fixtures + render harness for the U5 goldens and a11y tests
 * (SPEC-0008 §5.2/§5.5, §5.1 seeding pattern): REAL pushed engine content
 * through the landed receive flow (testing/seed-repo.ts), D1 from the
 * generated migrations, and the synthetic ASSETS manifest fetcher — the same
 * fixture shape as pages.test.ts, with fixed dates/contents so every render
 * is byte-deterministic (§5.2: same seed fixtures → byte-identical HTML).
 *
 * Slugs are distinct from pages.test.ts's ("golden" / "golden-alt") so the
 * two files' fixtures never share repo rows, and the committed goldens are
 * stable no matter which files ran before.
 *
 * Golden-update mechanism (§5.2 regeneration): workerd tests have no
 * filesystem writes and shell env vars do not reach the worker (verified
 * 2026-10-24: `process.env` inside the vitest workerd context carries only
 * miniflare bindings + Vite's own vars), so the env-var pattern is not
 * available. Instead `update-goldens.mjs` (same directory) drops a sentinel
 * file, runs vitest, and extracts marker-delimited renders from stdout.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories } from "../../db/schema";
import { type UiManifest } from "../manifest";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";

// --- deterministic fixtures (mirrors pages.test.ts's seeding) -----------------

/** Synthetic manifest shaped like the real Vite output; the fixed pseudo-
 *  hashes make goldens stable across asset rebuilds without normalization
 *  (SPEC-0008 §5.2's normalization exists for the real-manifest case). */
export const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": {
    file: "js/index.deadbeef.js",
    imports: ["web_src/js/secondary.ts"],
    css: ["css/index.1111aaaa.css"],
  },
  "web_src/js/secondary.ts": { file: "js/secondary.2222bbbb.js", css: ["css/secondary.3333cccc.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

export const fakeAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

type UiTestEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
export const uiEnv: UiTestEnv = { ...env, ASSETS: fakeAssets };

/** Fixed epoch: 2023-11-14T22:13:20Z — every date on every golden derives
 *  from this constant (pages.test.ts's T0), never from Date.now(). */
export const T0 = 1_700_000_000;

export const README = [
  "# Hello cf-gitea",
  "",
  "Some *markdown* with a [relative link](docs/guide.md).",
  "",
  "## Details",
  "",
  "Plain paragraph.",
  "",
].join("\n");

const APP_TS = [
  "export function main(): void {",
  '  console.log("hello cf-gitea");',
  "}",
  "",
].join("\n");

const GUIDE_MD = ["# Guide", "", "Walkthrough text.", ""].join("\n");

/** Null-byte-leading bytes: the §4.2 binary sniff fires, the .png extension
 *  picks the image media branch. */
const LOGO_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

/** Commit 1 writes the README, commit 2 everything else — §3.5 per-entry
 *  enrichment resolves DIFFERENT commits per row (pages.test.ts's shape). */
const GOLDEN_COMMITS: SeedCommit[] = [
  { message: "initial commit: add README", time: T0, files: [{ path: "README.md", content: README }] },
  {
    message: "add app source and docs",
    time: T0 + 120,
    files: [
      { path: "README.md", content: README },
      { path: "app.ts", content: APP_TS },
      { path: "docs/guide.md", content: GUIDE_MD },
      { path: "logo.png", content: LOGO_PNG },
    ],
  },
];

/** A DIFFERENT seed (one commit, different file/subject/time) — the
 *  determinism guard renders two seeds and requires different bytes. */
const ALT_COMMITS: SeedCommit[] = [
  {
    message: "alt seed: single commit",
    time: T0 + 300,
    files: [{ path: "only.txt", content: "alt content\n" }],
  },
];

// --- render helper -------------------------------------------------------------

/** Route-level render through the mounted uiRouter — the real production
 *  path (parse → resolve → load → renderPage), with the synthetic manifest. */
export async function renderRoute(path: string): Promise<{ status: number; html: string }> {
  const res = await uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
  return { status: res.status, html: await res.text() };
}

// --- the golden inventory (§5.2: three pages + 404 shell + bare shell) ---------

export interface GoldenCase {
  /** Committed file name under __tests__/goldens/. */
  file: string;
  /** Route rendered into the golden. */
  path: string;
  /** Expected HTTP status (404 shells are goldens too, §4.5). */
  status: number;
}

export const GOLDEN_CASES: GoldenCase[] = [
  { file: "home.html", path: "/alice/golden", status: 200 },
  { file: "commits.html", path: "/alice/golden/commits", status: 200 },
  { file: "file-view-code.html", path: "/alice/golden/src/branch/main/app.ts", status: 200 },
  // 404 shell WITH repo context (the repo resolved, the ref did not, §4.5).
  { file: "not-found-repo.html", path: "/alice/golden/commits/branch/nope", status: 404 },
  // Bare shell: 404 for an unknown owner/repo — navbar/main/footer, no repo
  // header, no discriminator class.
  { file: "bare-shell.html", path: "/nobody/nothing", status: 404 },
];

/** Marker frame the update script extracts golden bodies from (a single
 *  console.log per golden keeps the block contiguous in vitest's stream). */
export const GOLDEN_MARKER_START = "@@GOLDEN:";
export const GOLDEN_MARKER_END = "@@END-GOLDEN@@";

let seeded = false;

/** Idempotent seeding for both files (goldens.test.ts + a11y.test.ts). */
export function setupGoldenFixtures(): void {
  beforeAll(async () => {
    if (seeded) return;
    seeded = true;
    await applyAuthD1Migrations();
    for (const slug of ["golden", "golden-alt"]) {
      await ensureSeededRepo({
        owner: "alice",
        slug,
        commits: slug === "golden" ? GOLDEN_COMMITS : ALT_COMMITS,
        tags: slug === "golden" ? [{ name: "v1", commitIndex: 1 }] : undefined,
      });
      // The shell renders the row's `created_at` ("Created <relative-time…>");
      // fresh rows stamp unixepoch(), which would put wall-clock time into
      // the goldens. Pin it to the fixed epoch — determinism is a fixture
      // property (§5.2), the shell renders whatever the row carries.
      await drizzle(env.DB)
        .update(repositories)
        .set({ createdAt: new Date(T0 * 1000) })
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, slug)));
    }
  });
}
