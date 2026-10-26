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
  type ParsedUiRoute,
  type UiAssetsFetcher,
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

/**
 * The test bindings type: ASSETS re-narrowed to the fetcher the ui module
 * reads. The landed wrangler.jsonc assets block makes Env.ASSETS the
 * generated `Fetcher`; these tests inject a synthetic manifest fetcher (or
 * drop the binding entirely to exercise the 503 path), so the member is
 * re-declared optional. The single `as Env` at the fetch boundary re-widens
 * for the router's Bindings — the shapes agree everywhere the router reads.
 */
type UiTestEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const uiEnv: UiTestEnv = { ...env, ASSETS: fakeAssets };

/** An env that deterministically has no usable ASSETS binding. */
const envWithoutAssets: UiTestEnv = { ...env, ASSETS: undefined };

async function fetchUi(path: string, e: UiTestEnv = uiEnv): Promise<Response> {
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
    "/octo/hello/issues/new", // wave-4 form family (GET + POST handlers)
    "/octo/hello/settings", // wave-4 basics family
    "/octo/hello/settings/hooks", // wave-4 webhooks family
    "/octo/hello/settings/branches", // wave-15 protected-branches family
    "/octo/hello/commit/abc1234", // wave-18 commit view (the survey's #1;
    "/octo/hello/commit/abc1234.patch", // the sha validates at load time —
                                        // any single tail segment claims and
                                        // a non-hex one 404-shells there)
    "/octo/api/commits", // reserved names bind the OWNER segment only
    "/octo/hello%20two",
    "/octo/hello/milestones", // wave-6 milestones list family
    "/octo/hello/milestones/new", // wave-6 new-milestone family (GET + POST)
    "/octo", // wave-6 org home extended in wave 7 — the single-segment
    "/octo/", // owner-home family (the dispatcher never consults the gate
              // for it; the parser still owns it)
    "/", // wave-9 site root (the dispatcher never consults the gate for it
         // either — not repo-scoped; the parser still owns it)
    "/explore", // the wave-9 explore group: the bare literal's 303 + the
    "/explore/repos", // two search pages (claimed before the repo-scoped
    "/explore/users", // owner/repo parse could read them as a repository)
  ])("claims UI family: %s", (pathname) => {
    expect(handlesUiRoute(pathname)).toBe(true);
  });

  it.each([
    "/login", // the session router's literals (TOP_LEVEL_EXCLUDED — a
    "/LOGOUT", // dynamic /:owner registration would shadow them)
    "/healthz", // the dispatcher's own static route
    "/octo.keys", // upstream org Home's early-NotFound suffixes
    "/octo.gpg",
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
    "/octo/hello/settings/keys", // the deeper settings space stays engine-owned (wave 4 claims /settings + /settings/hooks; wave 15 claims /settings/branches + its writes — keys/tags stay engine-owned)
    "/octo/hello/commit/abc1234/extra", // wave-18 claims the single {sha}
    "/octo/hello/commit", // segment only — deeper tails and the bare literal
                          // stay engine-owned (upstream web.go:1740/1760)
    "/octo/hello/raw/branch/main/x", // upstream raw shape not in this slice
    "/octo/hello/commitsX", // family literals are exact
    "/octo/hello/commitsx/branch/main",
    "/explore/organizations", // the wave-9 explore literals bind exactly —
    "/explore/code", // every other tail stays engine/parent-owned
    "/explore/repos/sitemap-1.xml",
    "/explore/users/extra",
  ])("does not claim: %s", (pathname) => {
    expect(handlesUiRoute(pathname)).toBe(false);
  });
});

// --- parseUiRoute --------------------------------------------------------------

describe("parseUiRoute", () => {
  const table: Array<[string, ParsedUiRoute | null]> = [
    ["/octo/hello", { family: "home", owner: "octo", repo: "hello", refSuffix: null }],
    // exactly one trailing .git trimmed after decoding (gate convention, §4.4)
    ["/octo/hello.git", { family: "home", owner: "octo", repo: "hello", refSuffix: null }],
    ["/octo/r%2Egit/commits", { family: "commits", owner: "octo", repo: "r", refSuffix: null }],
    ["/octo/hello/", { family: "home", owner: "octo", repo: "hello", refSuffix: null }],
    // wave-6: the single-segment owner-home family (no .git trim — an owner
    // namespace, not a repo), its excluded literals, and the milestones pair.
    // Wave 7: the family serves USER profiles too — the URL shape is the
    // same, so the parse result is identical for user and org names; the
    // row type picks the page at resolution (pages/user-profile.tsx).
    ["/octo", { family: "owner-home", owner: "octo" }],
    ["/octo/", { family: "owner-home", owner: "octo" }],
    ["/OCTO", { family: "owner-home", owner: "OCTO" }], // request casing preserved
    ["/alice", { family: "owner-home", owner: "alice" }], // a user name — same family
    ["/login", null],
    ["/healthz", null],
    ["/octo.keys", null],
    ["/octo.gpg", null],
    ["/octo/hello/milestones", { family: "milestones", owner: "octo", repo: "hello" }],
    ["/octo/hello/milestones/new", { family: "milestone-new", owner: "octo", repo: "hello" }],
    ["/octo/hello/milestones/1", null], // the deeper write tails stay engine-owned
    // Wave 26: the `{id}/edit` combo and the singular `/milestone/{id}`
    // detail route claim their shapes (the survey's TOP-3 row).
    ["/octo/hello/milestones/1/edit", { family: "milestone-edit", owner: "octo", repo: "hello", id: "1" }],
    ["/octo/hello/milestone/1", { family: "milestone-detail", owner: "octo", repo: "hello", id: "1" }],
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
    // wave 9: the site root (upstream Home — dashboard signed in, landing
    // anonymous) and the explore literals, claimed before the owner/repo
    // parse could read `/explore/repos` as a repository.
    ["/", { family: "site-home" }],
    ["/explore", { family: "explore-root" }],
    ["/explore/", { family: "explore-root" }], // trailing slash canonicalizes
    ["/explore/repos", { family: "explore-repos" }],
    ["/explore/users", { family: "explore-users" }],
    ["/explore/organizations", null], // the literals bind exactly
    ["/explore/repos/sitemap-1.xml", null],
    ["/explore/users/extra", null],
    ["/EXPLORE", { family: "owner-home", owner: "EXPLORE" }], // same-named
    ["/Explore/repos", { family: "home", owner: "Explore", repo: "repos", refSuffix: null }], // namespaces keep their families (case-exact literals)
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
    expect(assetsBinding(uiEnv as Env)).toBe(fakeAssets);
    expect(assetsBinding(envWithoutAssets as Env)).toBeUndefined();
  });
});

// --- uiRouter (U2.5: every claimed route renders the 404-in-shell) ---------------

describe("uiRouter", () => {
  it("renders the U3 empty-repo home page for a resolved repo the engine has no content for", async () => {
    await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");

    const res = await fetchUi("/alice/hello");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();

    // Full shell (§2.4.1), assets resolved from the injected manifest.
    expect(html.startsWith('<!DOCTYPE html><html lang="en" data-theme="gitea-light">')).toBe(true);
    expect(html).toContain('id="global-window-config"');
    expect(html).toContain('"appUrl":"https://test.local/"');
    expect(html).toContain('src="/assets/js/iife.abcd1234.js"');
    expect(html).toContain('href="/assets/css/index.1111aaaa.css"');
    expect(html).toContain('<nav id="navbar"');
    expect(html).toContain('<footer class="page-footer"');

    // Repo context: header, original-row casing (D1 stores folded names),
    // visibility badge — and the §4.1 empty-repo render (unborn HEAD, the
    // engine cell was never pushed): clone command + push hint, no file list.
    expect(html).toContain("<title>Quick Start - alice/hello</title>");
    expect(html).toContain('<div class="repo-header flex-left-right">');
    expect(html).toContain('href="/alice/hello"');
    expect(html).toContain('<span class="ui basic orange label">Public Access</span>');
    expect(html).toContain('class="page-content repository quickstart"');
    expect(html).toContain("https://test.local/alice/hello.git");
    expect(html).not.toContain("repo-files-table");
    expect(html).not.toContain("status-page-error");
  });

  it("404-shells the commits and src families while the engine cell is empty (§4.5)", async () => {
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

  it("serves HEAD on claimed families through the GET handler (upstream chi parity)", async () => {
    // Hono registers GET handlers for HEAD too; §2.1's GET-only rule means
    // the UI claims no separate HEAD surface — the page status mirrors GET
    // (200 on a live page; the pre-U3 suite's "plain 404" was the stub-era
    // answer, and the runtime strips the body for HEAD).
    await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");
    const res = await uiRouter.fetch(new Request("https://test.local/alice/hello", { method: "HEAD" }), uiEnv);
    expect(res.status).toBe(200);
  });
});
