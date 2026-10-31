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
import { repositories, repoSettings, users } from "../db/schema";
import { getOrInsertBlob, packageBlobContentKey } from "../services/packages/blobs";
import { getOrInsertPackage, getOrInsertVersion, tryInsertFile } from "../services/packages/model";
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
 * re-declared optional. PACKAGES_ENABLED is re-declared beside it — the
 * SPEC-0016 M2 quota gate's strict-polarity rows override the var on a
 * per-fetch env literal. The single `as Env` at the fetch boundary re-widens
 * for the router's Bindings — the shapes agree everywhere the router reads.
 */
// PACKAGES_ENABLED is omitted too: wrangler types generates LITERAL var types
// ("true"), and an intersection cannot widen a literal back to string — the
// override must REPLACE the key (CI's regenerated Env caught what the stale
// local d.ts hid, run 40881266593).
type UiTestEnv = Omit<Env, "ASSETS" | "PACKAGES_ENABLED"> & { ASSETS?: UiAssetsFetcher; PACKAGES_ENABLED?: string };

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

/**
 * One package + version through the LANDED model service (the SPEC-0016 M2
 * route-level fixtures' arm — the packages matrix's seed shape; a distinct
 * `now` per call drives the created-desc "latest" pick).
 */
async function seedPackageVersion(
  ownerId: number,
  name: string,
  version: string,
  now: Date,
): Promise<{ packageId: number; versionId: number }> {
  const { row: pkg } = await getOrInsertPackage(env.DB, { ownerId, type: "generic", name, now });
  const { row: ver } = await getOrInsertVersion(env.DB, {
    packageId: pkg.id,
    creatorId: ownerId,
    version,
    now,
  });
  return { packageId: pkg.id, versionId: ver.id };
}

/**
 * One file (and its content-addressed blob row + R2 object) under a version —
 * the upload pipeline's landing half without the HTTP pass. Answers the file
 * row id (the download URL's {fileid} segment).
 */
async function seedPackageFile(versionId: number, name: string, payload: string): Promise<number> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { row: blob } = await getOrInsertBlob(env.DB, { size: bytes.byteLength, sha256 });
  const inserted = await tryInsertFile(env.DB, { versionId, blobId: blob.id, name });
  if (inserted.outcome !== "created") throw new Error("package file seed failed");
  await env.REPO_PACKS.put(packageBlobContentKey(sha256), bytes);
  return inserted.row.id;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  resetManifestCache();
  for (const table of [
    "personal_access_tokens",
    // The SPEC-0016 M2 fixture tables (children first — the packages matrix's
    // sweep convention) + the R16 gate's settings row.
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "repo_settings",
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
    "/explore/code", // SPEC-0019 M2 claimed the literal (the navbar's fourth
                     // tab; the explore-code matrix pins the page render)
    "/octo/-/packages", // the SPEC-0016 M2 `/-` packages subtree: the list
    "/octo/-/packages/generic/proj", // literal, the {type}/{name} redirect,
    "/octo/-/packages/generic/proj/versions", // the /versions literal (it
                                              // outranks the {version} param),
    "/octo/-/packages/generic/proj/1.0.0", // the {version} view, and the
    "/octo/-/packages/generic/proj/1.0.0/files/7", // {fileid} download
    "/octo/-/code", // the code-search twin in the same `/-` namespace
    "/octo/hello/packages", // the R16 repo tab literal (the settings row
                            // gates the handler — the route-level rows below)
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
    "/octo/hello/commit/abc1234/extra", // wave-18 claims the single {sha}
    "/octo/hello/commit", // segment only — deeper tails and the bare literal
                          // stay engine-owned (upstream web.go:1740/1760)
    "/octo/hello/commitsX", // family literals are exact
    "/octo/hello/commitsx/branch/main",
    "/explore/users/extra",
    "/octo/-/packages/generic", // the bare {type} facet rides the list's ?type=
    "/octo/-/PACKAGES", // the family literal is lowercase-exact
    "/octo/-/packages/generic/proj/1.0.0/files", // the download tail claims a
    "/octo/-/packages/generic/proj/1.0.0/files/x", // numeric {fileid} only
    "/octo/-/packages/generic/proj/1.0.0/extra", // deeper tails stay engine-owned
    "/octo/hello/packages/extra", // the repo tab claims the bare literal only
    // NOTE: /octo/hello/settings/keys and /explore/repos/sitemap-1.xml left
    // this table — window-2d (b54f709) and window-2e-A (84996c6) claimed
    // them; the claim pins live in the parse table below (the wiki
    // matrix's escalation). /octo/hello/raw/branch/main/x and
    // /explore/organizations left it too — the raw/media wave claimed the
    // web raw shapes and the orgs page (the raw-files + explore-orgs
    // matrices' pins). /explore/code left it as well — SPEC-0019 M2
    // claimed the literal (the explore-code matrix's pin beside the
    // navbar's fourth tab).
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
    ["/explore/organizations", { family: "explore-organizations" }], // the orgs page (the raw/media wave's R01)
    ["/octo/hello/raw/branch/main/x", { family: "raw-file", owner: "octo", repo: "hello", refType: "branch", refSuffix: "main/x" }],
    ["/octo/hello/media/blob/0123456789abcdef0123456789abcdef01234567", { family: "media-file", owner: "octo", repo: "hello", sha: "0123456789abcdef0123456789abcdef01234567" }],
    ["/octo/hello/raw/main/x", { family: "raw-file", owner: "octo", repo: "hello", legacySuffix: "main/x" }],
    ["/explore/repos/sitemap-1.xml", { family: "explore-repos-sitemap", idx: 1 }], // window-2e-A (84996c6)
    ["/explore/users/extra", null],
    ["/EXPLORE", { family: "owner-home", owner: "EXPLORE" }], // same-named
    ["/Explore/repos", { family: "home", owner: "Explore", repo: "repos", refSuffix: null }], // namespaces keep their families (case-exact literals)
    // The SPEC-0016 M2 packages subtree (the `/-` namespace's depth — upstream
    // web.go:1109-1121): the /versions literal outranks the {version} param
    // (chi registers the static tail first), the fileid is the PathParamInt64
    // parity ("007" parses as 7), and every junk shape stays unclaimed → the
    // engine's 404. Type/name/version decode like the /src family.
    ["/octo/-/packages", { family: "owner-packages", owner: "octo" }],
    ["/octo/-/packages/generic", null], // the bare {type} facet rides ?type=
    [
      "/octo/-/packages/generic/proj",
      { family: "owner-package-redirect", owner: "octo", type: "generic", name: "proj" },
    ],
    [
      "/octo/-/packages/gener%69c/proj",
      { family: "owner-package-redirect", owner: "octo", type: "generic", name: "proj" },
    ],
    ["/octo/-/packages/%zz/proj", null], // undecodable escapes stay unclaimed
    [
      "/octo/-/packages/generic/proj/versions",
      { family: "owner-package-versions", owner: "octo", type: "generic", name: "proj" },
    ],
    [
      "/octo/-/packages/generic/proj/1.0.0",
      { family: "owner-package-version-view", owner: "octo", type: "generic", name: "proj", version: "1.0.0" },
    ],
    [
      "/octo/-/packages/generic/proj/1.0.0/files/7",
      {
        family: "owner-package-file-download",
        owner: "octo",
        type: "generic",
        name: "proj",
        version: "1.0.0",
        fileId: 7,
      },
    ],
    [
      "/octo/-/packages/generic/proj/1.0.0/files/007",
      {
        family: "owner-package-file-download",
        owner: "octo",
        type: "generic",
        name: "proj",
        version: "1.0.0",
        fileId: 7, // the PathParamInt64 parity — the zero-padded id parses
      },
    ],
    ["/octo/-/packages/generic/proj/1.0.0/files", null],
    ["/octo/-/packages/generic/proj/1.0.0/files/x", null], // junk fileid
    ["/octo/-/packages/generic/proj/1.0.0/extra", null],
    // The SPEC-0019 M2 code-search twins and the R16 repo tab (upstream
    // web.go:1136's `/-/code` literal, web.go:558's explore literal,
    // web.go:1546's bare repo `/packages`).
    ["/octo/-/code", { family: "user-code-search", owner: "octo" }],
    ["/explore/code", { family: "explore-code" }],
    ["/octo/hello/packages", { family: "repo-packages", owner: "octo", repo: "hello" }],
    ["/octo/hello/packages/extra", null],
    // The census C4 artifacts preview subtree: the repo family (digits-only
    // {id}, the decoded /preview tail with "/" separators rejoined) and the
    // root SIGNED raw family (base64url signature verbatim, junk stays
    // engine-owned).
    ["/octo/hello/actions/artifacts/7/preview", { family: "actions-artifact-preview", owner: "octo", repo: "hello", artifactId: 7, previewPath: "" }],
    [
      "/octo/hello/actions/artifacts/007/preview/dir/sub%20file.txt",
      {
        family: "actions-artifact-preview",
        owner: "octo",
        repo: "hello",
        artifactId: 7, // the PathParamInt64 parity — zero-padded parses
        previewPath: "dir/sub file.txt",
      },
    ],
    ["/octo/hello/actions/artifacts/x/preview", null], // junk id
    ["/octo/hello/actions/artifacts/7", null], // the bare sibling stays unclaimed
    [
      "/-/actions/artifacts/7/1893456000/c2lnbmF0dXJl",
      { family: "actions-artifact-preview-raw", artifactId: 7, expires: 1893456000, signature: "c2lnbmF0dXJl", previewPath: "" },
    ],
    [
      "/-/actions/artifacts/7/1893456000/c2lnbmF0dXJl/dir/f%2Fname.bin",
      {
        family: "actions-artifact-preview-raw",
        artifactId: 7,
        expires: 1893456000,
        signature: "c2lnbmF0dXJl",
        previewPath: "dir/f/name.bin",
      },
    ],
    ["/-/actions/artifacts/x/1893456000/c2lnbmF0dXJl", null], // junk id
    ["/-/actions/artifacts/7/x/c2lnbmF0dXJl", null], // junk expiry
    ["/-/actions/artifacts/7/1893456000/c2lnbmF0dXJl/%zz", null], // undecodable tail
    ["/-/actions/other", null], // the /-/actions group claims only the artifacts subtree
    // The org settings packages family (the nesting-bug guard — these shapes
    // once sat inside the runners-delete arm and were unreachable).
    ["/acme/settings/packages", { family: "org-settings-packages", owner: "acme" }],
    ["/acme/settings/packages/rules/add", { family: "org-settings-packages-rule-add", owner: "acme" }],
    ["/acme/settings/packages/rules/7", { family: "org-settings-packages-rule-edit", owner: "acme", id: 7 }],
    ["/acme/settings/packages/rules/7/preview", { family: "org-settings-packages-rule-preview", owner: "acme", id: 7 }],
    ["/acme/settings/packages/cargo/initialize", null], // the cargo tails stay unregistered
    ["/acme/settings/packages/rules/junk", null], // non-numeric id
    // The USER-scope packages family (the same nesting-bug guard class).
    ["/user/settings/packages", { family: "user-settings-packages", id: null }],
    ["/user/settings/packages/rules/add", { family: "user-settings-packages-rule-add", id: null }],
    ["/user/settings/packages/rules/7", { family: "user-settings-packages-rule-edit", id: 7 }],
    ["/user/settings/packages/rules/7/preview", { family: "user-settings-packages-rule-preview", id: 7 }],
    ["/user/settings/packages/cargo/initialize", null], // cargo/chef tails unregistered
    ["/user/settings/packages/rules/junk", null], // non-numeric id
    // The P2-1/P2-2 actions-general mounts (web.go:722/:724 user,
    // :1052/:1054 org — the bare group redirects + the General pages).
    ["/acme/settings/actions", { family: "org-settings-actions-redirect", owner: "acme" }],
    ["/acme/settings/actions/general", { family: "org-settings-actions-general", owner: "acme" }],
    ["/user/settings/actions", { family: "user-settings-actions-redirect", id: null }],
    ["/user/settings/actions/general", { family: "user-settings-actions-general", id: null }],
    // The store wave's SCOPED-WORKFLOWS mounts (web.go:517-523's shared
    // four-route group at the three scopes — web.go:730 user, :1060 org,
    // :903 admin): the GET page literals + the three static write tails.
    ["/user/settings/actions/scoped-workflows", { family: "user-settings-actions-scoped-workflows", id: null }],
    ["/user/settings/actions/scoped-workflows/add", { family: "user-settings-actions-scoped-workflows-add", id: null }],
    ["/user/settings/actions/scoped-workflows/required", { family: "user-settings-actions-scoped-workflows-required", id: null }],
    ["/user/settings/actions/scoped-workflows/remove", { family: "user-settings-actions-scoped-workflows-remove", id: null }],
    ["/user/settings/actions/scoped-workflows/extra", null], // junk deeper tail
    ["/acme/settings/actions/scoped-workflows", { family: "org-actions-scoped-workflows", owner: "acme" }],
    ["/acme/settings/actions/scoped-workflows/add", { family: "org-actions-scoped-workflows-add", owner: "acme" }],
    ["/acme/settings/actions/scoped-workflows/required", { family: "org-actions-scoped-workflows-required", owner: "acme" }],
    ["/acme/settings/actions/scoped-workflows/remove", { family: "org-actions-scoped-workflows-remove", owner: "acme" }],
    ["/acme/settings/actions/scoped-workflows/extra", null],
    ["/-/admin/actions/scoped-workflows", { family: "admin-actions-scoped-workflows" }],
    ["/-/admin/actions/scoped-workflows/add", { family: "admin-actions-scoped-workflows-add" }],
    ["/-/admin/actions/scoped-workflows/required", { family: "admin-actions-scoped-workflows-required" }],
    ["/-/admin/actions/scoped-workflows/remove", { family: "admin-actions-scoped-workflows-remove" }],
    ["/-/admin/actions/scoped-workflows/extra", null],
    // The repo-scoped twin stays unclaimed — the repo settings actions
    // family has no scoped-workflows tail (the engine's 404).
    ["/alice/demo/settings/actions/scoped-workflows", null],
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
    // engine cell was never pushed): the ANONYMOUS arm of upstream
    // repo/empty.tmpl — the single repo.empty_message segment (the
    // webui-parity wave moved the Quick Guide behind CanWriteCode; the
    // title carries no page prefix — empty.tmpl sets none), no file list.
    expect(html).toContain("<title>alice/hello</title>");
    expect(html).toContain('<div class="repo-header flex-left-right">');
    expect(html).toContain('href="/alice/hello"');
    expect(html).toContain('<span class="ui basic orange label">Public Access</span>');
    expect(html).toContain('class="page-content repository quickstart"');
    expect(html).toContain(
      '<div class="ui segment center">This repository does not have any content.</div>',
    );
    expect(html).not.toContain("Quick Guide");
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

  it("carries the FULL request URI (path + query) in the anonymous login bounce", async () => {
    // Upstream reqSignIn → RedirectLinkUserLogin round-trips
    // `req.URL.RequestURI()` — path AND query (modules/web/middleware/
    // cookie.go:44) — so a bounce from /notifications?q=x must not lose
    // ?q=x (the v1.4 usability sweep's item 1).
    const bounce = await fetchUi("/notifications?q=alerts");
    expect(bounce.status).toBe(303);
    expect(bounce.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/notifications?q=alerts")}`,
    );

    // Multiple params survive together (& encoded inside the redirect_to
    // value — a single QueryEscape of the whole URI, like upstream).
    const multi = await fetchUi("/notifications?q=x&page=2");
    expect(multi.status).toBe(303);
    expect(multi.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/notifications?q=x&page=2")}`);

    // A query-less request keeps the bare-path shape — no trailing ?.
    const bare = await fetchUi("/notifications");
    expect(bare.status).toBe(303);
    expect(bare.headers.get("location")).toBe("/login?redirect_to=%2Fnotifications");
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

  it("renders the SPEC-0016 M2 owner packages subtree over a seeded package (list → 303 → versions → view → download)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    // The first version is deliberately named "versions" — the ordering pin
    // below only reads honestly when the {version} param HAS a body to match.
    await seedPackageVersion(alice.id, "proj", "versions", new Date(1_700_000_000 * 1000));
    const latest = await seedPackageVersion(alice.id, "proj", "1.0.0", new Date(1_700_000_100 * 1000));

    // The list (GET /alice/-/packages): the R04 page over the created-desc
    // latest-version rows — the rendered link carries the DISPLAY owner name
    // (the rows fold case at resolution, like every owner-scoped family).
    const list = await fetchUi("/alice/-/packages");
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain("<title>Packages - cf-gitea</title>");
    expect(listHtml).toContain('class="page-content user profile packages"');
    expect(listHtml).toContain('href="/Alice/-/packages/generic/proj/1.0.0"');

    // The {type}/{name} tail: upstream RedirectToLastVersion's 303 onto the
    // latest non-internal version.
    const redirect = await fetchUi("/alice/-/packages/generic/proj");
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe("/Alice/-/packages/generic/proj/1.0.0");

    // The /versions literal outranks the {version} param (chi registers the
    // static tail first; hono answers the first match) — EVEN with a version
    // literally named "versions" seeded: the URL answers the versions page
    // (the view's title would be the package name), never a view of it.
    const versions = await fetchUi("/alice/-/packages/generic/proj/versions");
    expect(versions.status).toBe(200);
    const versionsHtml = await versions.text();
    expect(versionsHtml).toContain("<title>Packages - cf-gitea</title>");
    expect(versionsHtml).toContain("<strong>Versions</strong>");
    expect(versionsHtml).toContain('href="/Alice/-/packages/generic/proj/versions"');

    // The {version} view.
    const view = await fetchUi("/alice/-/packages/generic/proj/1.0.0");
    expect(view.status).toBe(200);
    const viewHtml = await view.text();
    expect(viewHtml).toContain("<title>proj - cf-gitea</title>");

    // The {fileid} download: the version is the identity hop, the blob streams
    // from the content-addressed R2 object behind the attachment disposition.
    const fileId = await seedPackageFile(latest.versionId, "pkg-notes.txt", "package payload bytes");
    const download = await fetchUi(`/alice/-/packages/generic/proj/1.0.0/files/${fileId}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition") ?? "").toContain("pkg-notes.txt");
    expect(await download.text()).toBe("package payload bytes");
  });

  it("404-shells the owner packages subtree's miss arms (unknown owner, missing package)", async () => {
    await seedVerifiedUser({ username: "Alice" });

    for (const path of [
      "/nobody/-/packages", // an invisible owner collapses to the bare shell
      "/alice/-/packages/generic/missing", // RedirectToLastVersion's miss arm
    ]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).toContain("<title>Page Not Found - cf-gitea</title>");
      expect(html, path).toContain('<div class="status-page-error">');
    }
  });

  it("404-shells the whole owner packages subtree when PACKAGES_ENABLED=false (the strict-polarity quota gate)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await seedPackageVersion(alice.id, "proj", "1.0.0", new Date());

    const res = await fetchUi("/alice/-/packages", { ...uiEnv, PACKAGES_ENABLED: "false" });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("<title>Page Not Found - cf-gitea</title>");
    expect(html).toContain('<div class="status-page-error">');
  });

  it("gates the repo packages tab on the repo_settings.has_packages row (both polarities)", async () => {
    await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");
    const repo = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, "hello")).get();
    if (repo === undefined) throw new Error("seed repo missing");

    // Off polarity: no settings row renders the upstream defaults
    // (has_packages false) — the tab route 404-shells INSIDE the repo shell
    // (ctx.repo is resolved before the gate, so the header stays).
    const off = await fetchUi("/alice/hello/packages");
    expect(off.status).toBe(404);
    const offHtml = await off.text();
    expect(offHtml).toContain("<title>Page Not Found - alice/hello</title>");
    expect(offHtml).toContain('<div class="repo-header flex-left-right">');
    expect(offHtml).toContain('<div class="status-page-error">');

    // On polarity: the settings row arms the tab — the R16 page renders the
    // repo-scoped list with the Packages tab active.
    await drizzle(env.DB).insert(repoSettings).values({ repoId: repo.id, hasPackages: true });
    const on = await fetchUi("/alice/hello/packages");
    expect(on.status).toBe(200);
    const onHtml = await on.text();
    expect(onHtml).toContain("<title>Packages - alice/hello</title>");
    expect(onHtml).toContain('class="page-content repository packages"');
  });

  it("renders the SPEC-0019 M2 code-search twins (/explore/code + /{owner}/-/code)", async () => {
    await seedVerifiedUser({ username: "Alice" });

    // The explore page: the bare form answers without a seed read; the
    // navbar's fourth tab is live (the active explore item).
    const explore = await fetchUi("/explore/code");
    expect(explore.status).toBe(200);
    const exploreHtml = await explore.text();
    expect(exploreHtml).toContain("<title>Explore - cf-gitea</title>");
    expect(exploreHtml).toContain('action="/explore/code"');
    expect(exploreHtml).toContain('<a class="active item" href="/explore/repos">');

    // The owner twin: the same federated search block over the owner's base.
    const own = await fetchUi("/alice/-/code");
    expect(own.status).toBe(200);
    const ownHtml = await own.text();
    expect(ownHtml).toContain("<title>Code - cf-gitea</title>");
    expect(ownHtml).toContain('action="/Alice/-/code"');
  });
});
