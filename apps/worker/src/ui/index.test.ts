/**
 * UI router tests (SPEC-0008 §5 route slice, U2.5 gate):
 *
 * - pure tables for `handlesUiRoute` (UI vs api vs engine git paths vs
 *   /assets), `parseUiRoute` (decoding, .git trim, family literals) and the
 *   ref-suffix resolution (§3.3: slash-bearing branches/tags, sha forms);
 * - route-level renders of the mounted sub-app against real local D1,
 *   seeded via the auth testing helper pattern (`applyAuthD1Migrations` +
 *   `seedVerifiedUser`). No SELF: `src/index.ts` is orchestrator-owned and
 *   not yet wired (§2.2), so tests drive `uiRouter.fetch()` directly. The
 *   ASSETS binding is injected as a synthetic-manifest fetcher (same fixture
 *   shape as manifest.test.ts — the real build output is gitignored, tests
 *   never depend on `pnpm build:assets`).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../auth/testing/seeds";
import { repositories, users } from "../db/schema";
import { resetManifestCache, type UiManifest } from "./manifest";
import {
  assetsBinding,
  handlesUiRoute,
  parseUiRoute,
  resolveRefSuffix,
  splitRefSuffix,
  uiRouter,
  type UiAssetsFetcher,
  type UiRoute,
} from "./index";

// --- fixtures ----------------------------------------------------------------

/** Synthetic manifest shaped like the real Vite output (deterministic). */
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

const fakeAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

/** The test bindings: real D1 plus the injected ASSETS fetcher. (The real
 *  wrangler.jsonc has no assets block yet — U1 orchestrator wiring — so the
 *  raw `env` exercises the 503 path.) */
const uiEnv: Env & { ASSETS?: UiAssetsFetcher } = { ...env, ASSETS: fakeAssets };

/** An env that deterministically has no usable ASSETS binding. */
const envWithoutAssets: Env & { ASSETS?: UiAssetsFetcher } = { ...env, ASSETS: undefined };

async function fetchUi(path: string, e: Env & { ASSETS?: UiAssetsFetcher } = uiEnv): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), e);
}

async function seedRepo(
  ownerLower: string,
  slugLower: string,
  visibility: "public" | "private" = "public",
): Promise<void> {
  const owner = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, ownerLower))
    .get();
  if (owner === undefined) throw new Error(`seed owner ${ownerLower} missing`);
  const id = crypto.randomUUID();
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: ownerLower,
    ownerId: owner.id,
    slug: slugLower,
    visibility,
  });
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  resetManifestCache();
  for (const table of [
    "personal_access_tokens",
    "repo_units",
    "repo_counters",
    "repo_redirects",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- handlesUiRoute (the §2.2 dispatcher gate) --------------------------------

describe("handlesUiRoute", () => {
  it.each([
    // the §2.1 page families
    "/octo/hello",
    "/octo/hello.git",
    "/octo/hello/", // trailing slash — the router 301s to the canonical form
    "/octo/hello/commits",
    "/octo/hello/commits/",
    "/octo/hello/commits/branch/main",
    "/octo/hello/commits/branch/feature/deep/path",
    "/octo/hello/src",
    "/octo/hello/src/branch/main/deep/file.md",
    "/octo/hello.git/src/branch/main",
    "/octo/api/commits", // reserved names bind the OWNER segment only
    "/octo/hello%20two",
  ])("claims UI family: %s", (pathname) => {
    expect(handlesUiRoute(pathname)).toBe(true);
  });

  it.each([
    "/", // root — Hono-land
    "/octo", // single segment
    "/octo/",
    "/octo//hello", // empty segment
    "/octo/hello//commits",
    "/octo/.git", // repo trims to empty
    "/api/v1", // reserved owner "api" (also excluded by the dispatcher)
    "/api/v1/user",
    "/API/v1", // reservation folds case
    "/assets/x", // reserved owner "assets" — the edge-served tree
    "/Assets/img/logo.svg",
    "/octo/hello/info/refs", // git protocol (§2.1 non-routes)
    "/octo/hello.git/info/refs",
    "/octo/hello/git-upload-pack",
    "/octo/hello/git-receive-pack",
    "/octo/hello/HEAD",
    "/octo/hello/info/lfs/locks", // SPEC-0006 family
    "/octo/hello/settings", // engine JSON API/admin keeps ownership
    "/octo/hello/commit/abc1234", // commit-detail dead links (open question 1)
    "/octo/hello/raw/branch/main/x", // upstream raw shape not in this slice
    "/octo/hello/commitsX", // family literals are exact
    "/octo/hello/commitsx/branch/main",
  ])("does not claim: %s", (pathname) => {
    expect(handlesUiRoute(pathname)).toBe(false);
  });
});

// --- parseUiRoute --------------------------------------------------------------

describe("parseUiRoute", () => {
  const table: Array<[string, UiRoute | null]> = [
    ["/octo/hello", { family: "home", owner: "octo", repo: "hello", refSuffix: null }],
    // exactly one trailing .git trimmed after decoding (gate convention, §4.4)
    ["/octo/hello.git", { family: "home", owner: "octo", repo: "hello", refSuffix: null }],
    ["/octo/r%2Egit/commits", { family: "commits", owner: "octo", repo: "r", refSuffix: null }],
    ["/octo/hello/", { family: "home", owner: "octo", repo: "hello", refSuffix: null }],
    [
      "/octo/hello/commits/branch/feature%20one/file.md",
      { family: "commits", owner: "octo", repo: "hello", refSuffix: "branch/feature one/file.md" },
    ],
    ["/octo/hello/commits", { family: "commits", owner: "octo", repo: "hello", refSuffix: null }],
    ["/octo/hello/src", { family: "src", owner: "octo", repo: "hello", refSuffix: null }],
    [
      "/octo/hello/src/branch/main/a/b/c.txt",
      { family: "src", owner: "octo", repo: "hello", refSuffix: "branch/main/a/b/c.txt" },
    ],
    // family literals are lowercase-exact, like upstream's chi patterns
    ["/octo/hello/Commits", null],
    ["/octo/hello/commitsX", null],
    // undecodable escapes are the engine's (parse.ts convention)
    ["/octo/hello%zz/src", null],
    ["/octo/hello/commits/branch/%zz", null],
  ];

  it.each(table)("parses %s", (pathname, expected) => {
    expect(parseUiRoute(pathname)).toEqual(expected);
  });
});

// --- ref-suffix resolution (§3.3, upstream getRefName semantics) ---------------

const refs = {
  branches: ["main", "feature/foo", "release/v1.0"],
  tags: ["v1.0", "release/one"],
  defaultBranch: "main",
};

describe("splitRefSuffix", () => {
  it.each([
    ["branch/main", { refType: "branch", rest: "main" }],
    ["tag", { refType: "tag", rest: "" }],
    ["commit/deadbeef/x", { refType: "commit", rest: "deadbeef/x" }],
    ["branchy", null], // prefix must be exact
    ["refs/heads/main", null], // no prefix → 404 shell (§3.3)
  ])("splits %s", (suffix, expected) => {
    expect(splitRefSuffix(suffix)).toEqual(expected);
  });
});

describe("resolveRefSuffix", () => {
  it.each([
    // empty rest → the default branch, whatever the declared prefix
    ["branch", "", { refType: "branch", ref: "main", treePath: "" }],
    ["commit", "", { refType: "branch", ref: "main", treePath: "" }],
    ["branch", "main", { refType: "branch", ref: "main", treePath: "" }],
    ["branch", "main/README.md", { refType: "branch", ref: "main", treePath: "README.md" }],
    // slash-bearing branches: shortest existing cumulative prefix wins
    ["branch", "feature/foo", { refType: "branch", ref: "feature/foo", treePath: "" }],
    [
      "branch",
      "feature/foo/docs/index.md",
      { refType: "branch", ref: "feature/foo", treePath: "docs/index.md" },
    ],
    ["branch", "feature", null], // a prefix of a branch is not a branch
    ["branch", "nope", null],
    // HEAD → the default branch (branch type)
    ["branch", "HEAD", { refType: "branch", ref: "main", treePath: "" }],
    ["branch", "HEAD/src/index.ts", { refType: "branch", ref: "main", treePath: "src/index.ts" }],
    // tags resolve the same walk
    ["tag", "v1.0", { refType: "tag", ref: "v1.0", treePath: "" }],
    ["tag", "v1.0/notes.md", { refType: "tag", ref: "v1.0", treePath: "notes.md" }],
    ["tag", "release/one/x.yml", { refType: "tag", ref: "release/one", treePath: "x.yml" }],
    ["tag", "v2", null],
    // commit: 7..64 hex, no existence check at parse time (upstream parity)
    ["commit", "deadbee", { refType: "commit", ref: "deadbee", treePath: "" }],
    [
      "commit",
      "deadbeef0000000000000000000000000000000000/src/index.ts",
      { refType: "commit", ref: "deadbeef0000000000000000000000000000000000", treePath: "src/index.ts" },
    ],
    ["commit", "abc12", null], // shorter than 7
    ["commit", "deadbeefXYZ", null],
    // commit + HEAD needs an engine round-trip (default-branch commit id) —
    // null until the U3 page-data layer resolves it
    ["commit", "HEAD", null],
  ])("resolves %s/%s", (refType, rest, expected) => {
    expect(resolveRefSuffix(refType as "branch" | "tag" | "commit", rest, refs)).toEqual(expected);
  });

  it("prefers the shortest branch when both prefixes exist (upstream first-match walk)", () => {
    const both: typeof refs = { ...refs, branches: ["feature", "feature/foo"] };
    expect(resolveRefSuffix("branch", "feature/foo/x", both)).toEqual({
      refType: "branch",
      ref: "feature",
      treePath: "foo/x",
    });
  });

  it("falls back to the first branch when the default is unborn (upstream GetBranchNames(0,1))", () => {
    const unborn = { branches: ["develop", "main-adjacent"], tags: [], defaultBranch: "main" };
    expect(resolveRefSuffix("branch", "", unborn)).toEqual({ refType: "branch", ref: "develop", treePath: "" });
    expect(resolveRefSuffix("branch", "", { branches: [], tags: [], defaultBranch: "main" })).toBeNull();
  });
});

// --- assetsBinding / 503 path (§2.3.4) ------------------------------------------

describe("assetsBinding", () => {
  it("reads a present binding and returns undefined when absent or malformed", () => {
    expect(assetsBinding(uiEnv)).toBe(fakeAssets);
    expect(assetsBinding(envWithoutAssets)).toBeUndefined();
  });
});

// --- uiRouter (U2.5: every claimed route renders the 404-in-shell) ---------------

describe("uiRouter", () => {
  it("renders the 404 shell WITH repo context for a resolved public repo", async () => {
    await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");

    const res = await fetchUi("/alice/hello");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();

    // Full shell (§2.4.1), assets resolved from the injected manifest.
    expect(html.startsWith('<!DOCTYPE html><html lang="en" data-theme="gitea-light">')).toBe(true);
    expect(html).toContain('id="global-window-config"');
    expect(html).toContain('"appUrl":"https://test.local/"');
    expect(html).toContain('src="/assets/js/iife.abcd1234.js"');
    expect(html).toContain('href="/assets/css/index.1111aaaa.css"');
    expect(html).toContain('<nav id="navbar"');
    expect(html).toContain("<footer");

    // Repo context: header, original-row casing (D1 stores folded names),
    // visibility badge, and the repository page discriminator.
    expect(html).toContain("<title>Page Not Found - alice/hello</title>");
    expect(html).toContain('<div class="repo-header flex-left-right">');
    expect(html).toContain('href="/alice/hello"');
    expect(html).toContain('<span class="ui basic orange label">Public Access</span>');
    expect(html).toContain('class="page-content repository"');

    // The §4.5 404 content, and never the bare engine 404.
    expect(html).toContain('<div class="status-page-error">');
    expect(html).toContain('<div class="status-page-error-title">404 Not Found</div>');
    expect(html).not.toContain("Repository not found");
  });

  it("renders the same repo-context shell for the commits and src families", async () => {
    await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");

    for (const path of [
      "/alice/hello/commits?page=2",
      "/alice/hello/commits/branch/main",
      "/alice/hello/src",
      "/alice/hello/src/branch/feature/foo/deep/file.md",
      "/alice/hello.git/src/branch/main", // .git trim reaches the same repo
      "/ALICE/HELLO/commits", // case-folding at resolution, like the gate
    ]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).toContain("<title>Page Not Found - alice/hello</title>");
      expect(html, path).toContain('<div class="repo-header flex-left-right">');
      expect(html, path).toContain('<div class="status-page-error">');
    }
  });

  it("renders the bare 404 shell for an unknown repo (no repo header, never the engine body)", async () => {
    const res = await fetchUi("/nobody/nothing");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();

    expect(html).toContain("<title>Page Not Found - cf-gitea</title>");
    expect(html).not.toContain("repo-header");
    expect(html).toContain('class="page-content">'); // no repository discriminator
    expect(html).toContain('<div class="status-page-error">');
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toContain("Repository not found");
  });

  it("404-shells a private repo without repo context — never a 401 (§2.5)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "secret", "private");

    const res = await fetchUi("/alice/secret");
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const html = await res.text();
    expect(html).not.toContain("repo-header");
    expect(html).toContain('<div class="status-page-error">');
  });

  it("404-shells a public repo whose owner is limited or prohibited (§2.5 row-1 collapse)", async () => {
    const limited = await seedVerifiedUser({ username: "Limited" });
    await drizzle(env.DB).update(users).set({ visibility: "limited" }).where(eq(users.id, limited.id));
    await seedRepo("limited", "hello");
    await seedVerifiedUser({ status: "prohibited", username: "Gone" });
    await seedRepo("gone", "hello");

    for (const path of ["/limited/hello", "/gone/hello"]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).not.toContain("repo-header");
    }
  });

  it("301s trailing-slash URLs to the canonical form, query preserved (§4.13)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");

    const home = await fetchUi("/alice/hello/");
    expect(home.status).toBe(301);
    expect(home.headers.get("location")).toBe("https://test.local/alice/hello");

    const commits = await fetchUi("/alice/hello/commits/?page=2");
    expect(commits.status).toBe(301);
    expect(commits.headers.get("location")).toBe("https://test.local/alice/hello/commits?page=2");
  });

  it("answers 503 plain text when the ASSETS binding is absent (§2.3.4)", async () => {
    const res = await fetchUi("/alice/hello", envWithoutAssets);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toMatch(/pnpm build:assets|not configured/);
  });

  it("keeps GET-only surface: a HEAD request misses into the plain 404 (§2.1)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");
    const res = await uiRouter.fetch(new Request("https://test.local/alice/hello", { method: "HEAD" }), uiEnv);
    expect(res.status).toBe(404);
  });
});
