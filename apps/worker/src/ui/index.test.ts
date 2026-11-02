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
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../auth/testing/seeds";
import { applyTwofaEnrollment, clearTwofaSetCookie, generateTotpSecret, mintPendingTicket } from "../auth/two-factor";
import { totpCode } from "../auth/totp";
import { actionRunAttempts, actionRunJobs, actionRuns, comments, externalLoginUsers, issuePins, issues, loginSources, orgMembers, PRStatus, pullRequests, repositories, repoSettings, repoTransfer, repoUnits, teamMembers, trackedTimes, twoFactor, userSettingsKv, users } from "../db/schema";
import { ACTION_STATUS_FAILURE, ACTION_STATUS_PENDING, ACTION_STATUS_SUCCESS, ACTION_STATUS_WAITING, insertActionRun } from "../services/actions/model";
import type { RepositoryWithOwner } from "../api/services/repository";
import { branchRef, pullHeadRef, ZERO_OID } from "../api/services/engine";
import { RepoService } from "../repos/service";
import { IssuesService } from "../issues/service";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";
import { createWikiPageFromForm, parseWikiPageForm, wikiTipOf } from "./pages/repo-wiki";
import { TeamsService } from "../api/routes/org-teams";
import { OrgService } from "../services/orgs/orgs";
import { serializeOAuth2SourceConfig } from "../services/auth-sources/cfg";
import { createLoginSource, ensureExternalLogin, LoginSourceType } from "../services/auth-sources/store";
import { getOrInsertBlob, packageBlobContentKey } from "../services/packages/blobs";
import { getOrInsertPackage, getOrInsertVersion, tryInsertFile } from "../services/packages/model";
import { resetManifestCache, type UiManifest } from "./manifest";
import { mintSession, SESSION_COOKIE_NAME } from "./session";
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
    // The danger-threading battery's pending transfer row (references
    // repositories — goes before it, the children-first sweep convention).
    "repo_transfer",
    "repositories",
    // The run-viewer write-quartet battery's action rows (children first —
    // jobs/attempts under runs; the versions table the wake bumps).
    "action_runs",
    "action_run_jobs",
    "action_run_attempts",
    "action_tasks_versions",
    // The dead-route-fix route fixtures (children first): the unpin/time
    // ladders' issue rows, the pins, the comments the unpin writes, the
    // tracked-time rows the delete soft-deletes.
    "comments",
    "issue_pins",
    "tracked_time",
    "issues",
    // The W4 external-auth fixtures (the link rows first) + the sessions the
    // signed-in fetches mint.
    "external_login_user",
    "login_source",
    // The update_preferences battery's KV rows (references users).
    "user_settings_kv",
    "sessions",
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
    "/user/settings/security/account_link", // the W5 unlink POST (the dispatcher
                                            // admission the 1b17b08 referral re-arms)
    // the five dead-route fixes' dispatcher admissions (2026-11-01)
    "/octo/-/packages/settings/generic/proj", // F1 — settings FIRST
    "/octo/hello/upload-file", // F2 — the staging pair
    "/octo/hello/upload-remove",
    "/octo/hello/issues/unpin/7", // F3 — verb-first
    "/octo/hello/pulls/unpin/7",
    "/octo/hello/issues/5/times/9/delete", // F4 — four segments
    "/octo/hello/pulls/5/times/9/delete",
    "/octo/hello/_cherrypick/abcdef0/main", // F5 — the underscore literal
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
    // the five dead-route fixes' flipped shapes (2026-11-01): the shapes the
    // parse once claimed wrongly stay engine-owned
    "/octo/-/packages/settings/generic/proj/extra", // F1 — no deeper settings tails
    "/octo/hello/issues/7/unpin/3", // F3 — the index-first phantom
    "/octo/hello/issues/5/times/9", // F4 — the length-3 phantom (no /delete)
    "/octo/hello/cherrypick/abcdef0/main", // F5 — the bare literal is not an editor_action
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
    ["/acme/settings/packages/cargo/initialize", { family: "org-settings-packages-cargo-initialize", owner: "acme" }],
    ["/acme/settings/packages/cargo/rebuild", { family: "org-settings-packages-cargo-rebuild", owner: "acme" }],
    ["/acme/settings/packages/cargo/other", null], // the group claims the two write tails only
    ["/acme/settings/packages/rules/junk", null], // non-numeric id
    // The USER-scope packages family (the same nesting-bug guard class).
    ["/user/settings/packages", { family: "user-settings-packages", id: null }],
    ["/user/settings/packages/rules/add", { family: "user-settings-packages-rule-add", id: null }],
    ["/user/settings/packages/rules/7", { family: "user-settings-packages-rule-edit", id: 7 }],
    ["/user/settings/packages/rules/7/preview", { family: "user-settings-packages-rule-preview", id: 7 }],
    ["/user/settings/packages/cargo/initialize", { family: "user-settings-packages-cargo-initialize", id: null }], // the cargo tails ARE claimed (the e4d7e49 substrate; the chef tail is claimed too)
    ["/user/settings/packages/cargo/rebuild", { family: "user-settings-packages-cargo-rebuild", id: null }],
    ["/user/settings/packages/rules/junk", null], // non-numeric id
    // The P2-1/P2-2 actions-general mounts (web.go:722/:724 user,
    // :1052/:1054 org — the bare group redirects + the General pages).
    ["/acme/settings/actions", { family: "org-settings-actions-redirect", owner: "acme" }],
    ["/acme/settings/actions/general", { family: "org-settings-actions-general", owner: "acme" }],
    ["/user/settings/actions", { family: "user-settings-actions-redirect", id: null }],
    ["/user/settings/actions/general", { family: "user-settings-actions-general", id: null }],
    // The TOTP settings four (the twofa.tsx module header's HANDOFF recipe —
    // the 228b16e fold, security/2fa.go's group): the enroll GET+POST share
    // the one path family, the two write POSTs beside it; junk tails stay
    // engine-owned.
    ["/user/settings/security/two_factor/enroll", { family: "user-settings-security-twofa-enroll", id: null }],
    ["/user/settings/security/two_factor/regenerate_scratch", { family: "user-settings-security-twofa-regenerate", id: null }],
    ["/user/settings/security/two_factor/disable", { family: "user-settings-security-twofa-disable", id: null }],
    ["/user/settings/security/two_factor/enroll/extra", null], // deeper tails stay engine-owned
    ["/user/settings/security/two_factor/other", null], // unknown literal sibling
    ["/user/settings/security/two_factor", null], // the bare group is unclaimed (upstream 404s it too)
    // The W5 account-link unlink POST (security.go:50-70 — the settings
    // security page's Remove form's action; the 1b17b08 dead-route fix):
    // the POST-only family beside the bare security literal — the GET twin
    // answers the chi 405.
    ["/user/settings/security/account_link", { family: "user-settings-security-account-link", id: null }],
    ["/user/settings/security/account_link/extra", null], // deeper tails stay engine-owned
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
    // The W4 external-auth arm (pages/admin-auths.tsx — web.go:874-880's
    // /auths group): the list literal, the new combo, the digits-only
    // {authid} edit combo + delete tail (the PathParamInt64 parity —
    // zero-padded parses; junk stays unclaimed → the engine's 404).
    ["/-/admin/auths", { family: "admin-auths" }],
    ["/-/admin/auths/new", { family: "admin-auths-new" }],
    ["/-/admin/auths/7", { family: "admin-auths-edit", authId: 7 }],
    ["/-/admin/auths/007", { family: "admin-auths-edit", authId: 7 }], // zero-padded parses as 7
    ["/-/admin/auths/7/delete", { family: "admin-auths-delete", authId: 7 }],
    ["/-/admin/auths/x", null], // junk authid
    ["/-/admin/auths/x/delete", null], // junk authid under the delete tail
    ["/-/admin/auths/7/extra", null], // deeper tails stay engine-owned
    ["/-/admin/auths/new/delete", null], // the delete tail claims digits only
    ["/-/admin/auths/extra", null], // unknown literal sibling
    // The SPEC-0021 platform arms (the 6cc57d8 module's fold — the module
    // header's HANDOFF): the {qid} group's /set write (the queue NAME qid
    // rides the THIRD segment, upstream's chi group shape) and the two
    // 2-segment literals.
    ["/-/admin/monitor/queue/repo-tasks/set", { family: "admin-monitor-queue-set", qid: "repo-tasks" }],
    ["/-/admin/monitor/diagnosis", { family: "admin-monitor-diagnosis" }],
    ["/-/admin/monitor/profile", { family: "admin-monitor-profile" }],
    ["/-/admin/monitor/queue/repo-tasks/set/extra", null], // deeper tails stay engine-owned
    ["/-/admin/monitor/diagnosis/extra", null],
    ["/-/admin/monitor/profilez", null], // junk literal sibling
    // The remove-all write (web.go:807's group shape — the same {qid} third
    // segment as /set; the landed claim had the pair SEGMENT-SWAPPED and the
    // rendered form 404'd, the cd6ea38 referral fixed 2026-11-01).
    ["/-/admin/monitor/queue/repo-tasks/remove-all-items", { family: "admin-monitor-queue-remove-all", qid: "repo-tasks" }],
    ["/-/admin/monitor/queue/remove-all-items/repo-tasks", null], // the swapped shape stays unclaimed
    ["/-/admin/monitor/queue/repo-tasks/remove-all-items/extra", null],
    // The admin users family (web.go:817-821): the detail/edit/impersonate/
    // avatar combos — the edit claim was brace-nested inside the detail arm
    // until the cd6ea38 referral's placement fix (never reachable); these
    // pins hold the sibling shapes apart.
    ["/-/admin/users", { family: "admin-users" }],
    ["/-/admin/users/7", { family: "admin-user-detail", adminUserId: 7 }],
    ["/-/admin/users/7/edit", { family: "admin-user-edit", adminUserId: 7 }],
    ["/-/admin/users/7/impersonate", { family: "admin-users-impersonate", adminUserId: 7 }],
    ["/-/admin/users/7/avatar", { family: "admin-user-avatar", adminUserId: 7 }],
    ["/-/admin/users/7/avatar/delete", { family: "admin-user-avatar-delete", adminUserId: 7 }],
    ["/-/admin/users/x/edit", null], // junk id
    ["/-/admin/users/7/edit/extra", null], // deeper tails stay engine-owned
    ["/-/admin/users/edit", null], // the literal stays unclaimed (digits only)
    // The repo-scoped twin stays unclaimed — the repo settings actions
    // family has no scoped-workflows tail (the engine's 404).
    ["/alice/demo/settings/actions/scoped-workflows", null],
    // --- the five dead-route findings' parse pins (the deep review's F1-F5,
    // fixed 2026-11-01) ---
    // F1: the settings pair is SETTINGS-FIRST — upstream mounts it at
    // /settings/{type}/{name} (web.go:1121-1127), a SIBLING of the depth
    // group, so `settings` occupies the TYPE segment position; the tail
    // shape this table once pinned (settings LAST) falls to the version
    // view like upstream's {version} param would.
    ["/octo/-/packages/settings/generic/proj", { family: "owner-package-settings", owner: "octo", type: "generic", name: "proj" }],
    ["/octo/-/packages/settings/gener%69c/proj", { family: "owner-package-settings", owner: "octo", type: "generic", name: "proj" }],
    [
      "/octo/-/packages/generic/proj/settings",
      { family: "owner-package-version-view", owner: "octo", type: "generic", name: "proj", version: "settings" },
    ],
    ["/octo/-/packages/settings/generic/proj/extra", null], // deeper settings tails stay engine-owned
    // F2: the upload staging pair (web.go:1472-1474) — the bare repo-scope
    // literals, exactly the length-1 tail.
    ["/octo/hello/upload-file", { family: "editor-upload-file", owner: "octo", repo: "hello" }],
    ["/octo/hello/upload-remove", { family: "editor-upload-remove", owner: "octo", repo: "hello" }],
    ["/octo/hello/upload-file/extra", null], // deeper tails stay engine-owned
    // F3: the unpin DELETE tail is VERB-FIRST (web.go:1404's
    // m.Delete("/unpin/{index}") on the group root) — the index rides
    // rest[1]; the index-FIRST shape is upstream's 404.
    ["/octo/hello/issues/unpin/7", { family: "issue-unpin", owner: "octo", repo: "hello", urlKind: "issues", index: 7 }],
    ["/octo/hello/pulls/unpin/7", { family: "issue-unpin", owner: "octo", repo: "hello", urlKind: "pulls", index: 7 }],
    ["/octo/hello/issues/7/unpin/3", null], // the index-first phantom stays unclaimed
    ["/octo/hello/issues/unpin", null], // the bare verb stays unclaimed
    // F4: the per-time delete rides FOUR segments (web.go:1379's
    // m.Post("/{timeid}/delete") inside the /times group); the bare
    // /{index}/times/{timeid} tail is upstream's 404.
    [
      "/octo/hello/issues/5/times/9/delete",
      { family: "time-delete", owner: "octo", repo: "hello", urlKind: "issues", index: 5, timeId: 9 },
    ],
    [
      "/octo/hello/pulls/5/times/9/delete",
      { family: "time-delete", owner: "octo", repo: "hello", urlKind: "pulls", index: 5, timeId: 9 },
    ],
    ["/octo/hello/issues/5/times/9", null], // the length-3 phantom stays unclaimed
    ["/octo/hello/issues/5/times/x/delete", null], // junk timeid
    // F5: the cherrypick literal is upstream's OWN underscore spelling
    // (web.go:1468's {editor_action:_cherrypick}; the commit page's emitted
    // URL carries it) — the bare `cherrypick` head is NOT an editor_action.
    [
      "/octo/hello/_cherrypick/abcdef0123/main/x",
      { family: "editor-cherrypick", owner: "octo", repo: "hello", refSuffix: "abcdef0123/main/x" },
    ],
    ["/octo/hello/cherrypick/abcdef0123/main", null], // the bare literal stays engine-owned
    ["/octo/hello/_cherrypick/zzzzzz/main", null], // non-hex sha
    ["/octo/hello/_cherrypick/abcdef/main", null], // 6 < 7 hex
    ["/octo/hello/_cherrypick/abcdef0123", null], // no branch tail
    // --- the follow-up bundle's claim pins (2026-11-01) ---
    // The preferences write (web.go:636) — the exact literal, POST-only at
    // registration (the GET twin 405s).
    ["/user/settings/update_preferences", { family: "user-settings-update-preferences", id: null }],
    ["/user/settings/update_preferences/extra", null], // deeper tails stay engine-owned
    // The admin repos delete write (web.go:851) — the admin-emails-delete
    // shape beside the bare list literal.
    ["/-/admin/repos/delete", { family: "admin-repos-delete" }],
    ["/-/admin/repos/delete/extra", null], // deeper tails stay engine-owned
    // The org dashboard's heatmap JSON twins (web.go:984-985) — the literal
    // `-` + `heatmap` segments over the 6-/7-segment shapes; the team tail
    // is any decodable segment; every other deeper shape stays engine-owned.
    ["/org/acme/dashboard/-/heatmap", { family: "org-dashboard-heatmap", owner: "acme" }],
    ["/org/acme/dashboard/-/heatmap/Devs", { family: "org-dashboard-heatmap", owner: "acme", team: "Devs" }],
    ["/org/acme/dashboard/-/heatmap/devs/extra", null],
    ["/org/acme/dashboard/-/heatsink", null], // the literal heatmap only
    ["/org/acme/dashboard/-", { family: "org-dashboard", owner: "acme", team: "-" }], // the 5-segment team arm keeps its shape
    // The editor family's underscore aliases (web.go:1453-1467's spellings)
    // map onto the SAME families as the bare twins.
    ["/octo/hello/_new/main", { family: "file-new", owner: "octo", repo: "hello", refSuffix: "main" }],
    ["/octo/hello/_edit/main/x.txt", { family: "file-edit", owner: "octo", repo: "hello", refSuffix: "main/x.txt" }],
    ["/octo/hello/_delete/main/x.txt", { family: "file-delete", owner: "octo", repo: "hello", refSuffix: "main/x.txt" }],
    ["/octo/hello/_upload/main", { family: "file-upload", owner: "octo", repo: "hello", refSuffix: "main" }],
    ["/octo/hello/_diffpatch/main", { family: "editor-patch", owner: "octo", repo: "hello", refSuffix: "main" }],
    ["/octo/hello/_new", null], // the bare tail requirement holds for the aliases too
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

  // --- the W4 external-auth mount (pages/admin-auths.tsx — web.go:874-880's
  // /-/admin auths group; the parse claims above, the gate arms here) --------

  /** The signed-in fetch helper for the admin gate arms (the
   *  oauth2-authorize suite's cookie shape — mintSession returns id:secret).
   *  The ASSETS binding and any extra headers ride the options. */
  async function fetchAuthed(
    path: string,
    cookie: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, {
        method: options.method ?? "GET",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}`, ...options.headers },
        body: options.body,
      }),
      uiEnv,
    );
  }

  it("mounts the admin auths pages behind the admin gate (list 200 for the admin, the anonymous 303 and the non-admin 404 arms)", async () => {
    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });
    const cookie = await mintSession(env.DB, admin.id);

    // The list (GET /-/admin/auths): the admin chrome over the empty table.
    const list = await fetchAuthed("/-/admin/auths", cookie);
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain('class="page-content admin authentication"');
    expect(listHtml).toContain("Authentication Source Management");
    expect(listHtml).toContain('href="/-/admin/auths/new"');

    // The anonymous arm: the prologue 303s onto the login round-trip.
    const bounce = await fetchUi("/-/admin/auths");
    expect(bounce.status).toBe(303);
    expect(bounce.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/auths")}`);

    // The signed-in non-admin arm: the hidden admin surface 404-shells.
    const peon = await seedVerifiedUser({ username: "Peon" });
    const peonCookie = await mintSession(env.DB, peon.id);
    const forbidden = await fetchAuthed("/-/admin/auths", peonCookie);
    expect(forbidden.status).toBe(404);
    expect(await forbidden.text()).toContain("<title>Page Not Found - cf-gitea</title>");
  });

  it("serves the auths CRUD over the mounted routes (new form → create 303 → edit page → delete 303 → miss 404)", async () => {
    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });
    const cookie = await mintSession(env.DB, admin.id);
    const formHeaders = { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" };

    // The fresh new-form page.
    const fresh = await fetchAuthed("/-/admin/auths/new", cookie);
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain('action="/-/admin/auths/new"');

    // The create POST (upstream's wire fields): 303 onto the list. The
    // github provider rides the CRUD (the OIDC probe at save would
    // correctly refuse the fictional discovery URL — the matrix suite
    // pins that refusal; the CRUD here exercises the full round-trip).
    const create = await fetchAuthed("/-/admin/auths/new", cookie, {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({
        name: "corp-gh",
        oauth2_provider: "github",
        oauth2_key: "client-abc",
        oauth2_secret: "s3cret",
        is_active: "on",
      }).toString(),
    });
    expect(create.status).toBe(303);
    expect(create.headers.get("location")).toBe("/-/admin/auths");

    const row = await drizzle(env.DB).select().from(loginSources).get();
    expect(row?.name).toBe("corp-gh");
    const id = row!.id;

    // The list carries the row; the edit combo's GET renders it — the secret
    // stays write-only (never echoes).
    const listHtml = await (await fetchAuthed("/-/admin/auths", cookie)).text();
    expect(listHtml).toContain(`href="/-/admin/auths/${id}"`);
    const edit = await fetchAuthed(`/-/admin/auths/${id}`, cookie);
    expect(edit.status).toBe(200);
    const editHtml = await edit.text();
    expect(editHtml).toContain('value="corp-gh"');
    expect(editHtml).not.toContain("s3cret");

    // The delete POST: 303 back onto the list, the row gone — the edit GET
    // then 404-shells (the loader's null-miss arm through the route).
    const remove = await fetchAuthed(`/-/admin/auths/${id}/delete`, cookie, { method: "POST", headers: formHeaders });
    expect(remove.status).toBe(303);
    expect(remove.headers.get("location")).toBe("/-/admin/auths");
    const miss = await fetchAuthed(`/-/admin/auths/${id}`, cookie);
    expect(miss.status).toBe(404);
    expect(await miss.text()).toContain("<title>Page Not Found - cf-gitea</title>");
  });

  it("arms the auths POST guards (the cross-origin reject, the invalid re-render) and the delete tail's GET 405 twin", async () => {
    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });
    const cookie = await mintSession(env.DB, admin.id);

    // The §2.8 sameOriginGuard: a cross-origin POST is rejected before the
    // prologue's write.
    const forged = await fetchAuthed("/-/admin/auths/new", cookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "name=evil&oauth2_provider=github&oauth2_key=k&oauth2_secret=s",
    });
    expect(forged.status).toBe(403);

    // The invalid create arm re-renders the new page at 200 with the message
    // (the RenderWithErr posture — no row written).
    const invalid = await fetchAuthed("/-/admin/auths/new", cookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
      body: "name=&oauth2_provider=github&oauth2_key=k&oauth2_secret=s",
    });
    expect(invalid.status).toBe(200);
    const invalidHtml = await invalid.text();
    expect(invalidHtml).toContain("cannot be empty");
    expect(await drizzle(env.DB).select().from(loginSources).all()).toHaveLength(0);

    // The POST-only delete tail's GET twin answers chi's 405 (Allow: POST).
    const twin = await fetchAuthed("/-/admin/auths/1/delete", cookie);
    expect(twin.status).toBe(405);
    expect(twin.headers.get("allow")).toBe("POST");
  });
});

// --- the merge box fragment's reads-fed squash prefill (U31's handoff) -------
// --- the route's `reads: engineReads(c.env, repo)` input through the mount ---

describe("GET /:owner/:repo/pulls/:index/merge_box — the reads-fed squash prefill through the mount", () => {
  /** Worker-side object hash + one commit landed on a ref (the
   *  pull-merge-box.test.tsx landCommit twin — workerd crypto.subtle). */
  async function fragObjectOid(type: string, data: Uint8Array): Promise<string> {
    const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
    const bytes = new Uint8Array(header.byteLength + data.byteLength);
    bytes.set(header, 0);
    bytes.set(data, header.byteLength);
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  it("a stored-PR render carries the commit bullets in the textarea, not the Reviewed-on-only degradation", async () => {
    const alice = await seedVerifiedUser({ username: "U31Boxer" });
    const repo = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "u31boxer" },
      name: "fragbox",
      isPrivate: false,
      status: "ready",
    });
    const cell = env.REPO.getByName("u31boxer/fragbox");
    const land = async (
      ref: string,
      parents: string[],
      message: string,
      fileName: string,
      content: string,
      replaceOid?: string,
    ): Promise<string> => {
      const blob = new TextEncoder().encode(content);
      const blobOid = await fragObjectOid("blob", blob);
      const tree = serializeTree([{ mode: "100644", name: fileName, oid: blobOid }]);
      const person = { name: "seed", email: "seed@mergetest.invalid", time: 1_700_000_000, tz: "+0000" };
      const commit = serializeCommit({ tree: tree.oid, parents, author: person, committer: person, message: `${message}\n` });
      const put = await cell.putApiObjects([
        { oid: blobOid, type: "blob", data: blob },
        { oid: tree.oid, type: "tree", data: tree.data },
        { oid: commit.oid, type: "commit", data: commit.data },
      ]);
      if (put.tag !== "ok") throw new Error(`frag put failed: ${put.tag}`);
      const landed = await cell.commitApiChange({ ref, expectedOldOid: replaceOid ?? ZERO_OID, newOid: commit.oid });
      if (landed.tag !== "committed") throw new Error(`frag ref landing failed: ${ref} (${landed.tag})`);
      return commit.oid;
    };

    const rootOid = await land(branchRef("main"), [], "root", "README.md", "# fragbox\n");
    await cell.setHead("main");
    const c1 = await land(branchRef("fragbranch"), [rootOid], "frag: one\n\nwith a body", "FRAG_ONE.md", "one\n");
    const c2 = await land(branchRef("fragbranch"), [c1], "frag: two", "FRAG_TWO.md", "two\n", c1);

    const { pullRequest } = await new IssuesService(env.DB).createPullRequest({
      repoId: repo.id,
      title: "feat: frag squash",
      posterId: alice.id,
      headRepoId: repo.id,
      baseBranch: "main",
      headBranch: "fragbranch",
      content: "the frag body",
      now: new Date(1_761_000_000_000),
    });
    const index = pullRequest.index;
    await drizzle(env.DB).update(pullRequests).set({ status: PRStatus.Mergeable, headSha: c2 }).where(eq(pullRequests.id, pullRequest.id));
    const landed = await cell.commitApiChange({ ref: pullHeadRef(index), expectedOldOid: ZERO_OID, newOid: c2 });
    if (landed.tag !== "committed") throw new Error(`frag pull ref landing failed (${landed.tag})`);
    // The squash-default style + the COMMIT_MESSAGES template — the composed
    // default the write path stores for an unedited submit.
    await drizzle(env.DB).delete(repoUnits).where(eq(repoUnits.repoId, repo.id));
    await drizzle(env.DB).insert(repoUnits).values({
      repoId: repo.id,
      type: "pull_requests",
      config: JSON.stringify({ DefaultMergeStyle: "squash", DefaultSquashMergeMessage: "COMMIT_MESSAGES" }),
    });
    void rootOid;

    const cookie = await mintSession(env.DB, alice.id);
    const res = await uiRouter.fetch(
      new Request(`https://test.local/u31boxer/fragbox/pulls/${index}/merge_box`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      }),
      uiEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();

    // The composed body rides as the textarea's content (HTML-escaped like
    // any text node — the signature angle brackets): the walk's two bullets
    // oldest-first, the co-author block (the commit author "seed" is nobody's
    // account — the poster row carries no email), and the Reviewed-on line
    // joined through CommitMessageMerge. The Reviewed-on-ONLY shape is the
    // ABSENT-reads degradation — its absence here is the wiring pin.
    const body =
      "* frag: one\n\nwith a body\n\n* frag: two\n\n---------\n\n" +
      "Co-authored-by: seed <seed@mergetest.invalid>\n" +
      `Reviewed-on: https://test.local/u31boxer/fragbox/pulls/${index}`;
    const escaped = body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    expect(html).toContain(`>${escaped}</textarea>`);
    // The composed default swaps the title too (the style-switch pair).
    expect(html).toContain(`name="merge_title_field" value="feat: frag squash (#${index})"`);

    // Wire two's surface: the FULL PAGE render — loadIssueDetailData's
    // threaded optional reads (the route callers feed engineReads) — embeds
    // the same composed body inline.
    const page = await uiRouter.fetch(
      new Request(`https://test.local/u31boxer/fragbox/pulls/${index}`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      }),
      uiEnv,
    );
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain(`>${escaped}</textarea>`);
  });
});

// --- the TOTP settings four (the twofa.tsx module header's HANDOFF recipe —
// --- the 228b16e fold; upstream security/2fa.go's group) ----------------------

describe("the TOTP settings four (the twofa.tsx HANDOFF fold)", () => {
  // The enroll page renders over the settings layout; the three POSTs ride
  // the sameOriginGuard via the prologue's write mode. The pending-secret
  // stash is the signed gitea_twofa "enroll" ticket (auth/two-factor.ts).
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM two_factor").run();
  });

  async function fetchAuthed(
    path: string,
    cookie: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, {
        method: options.method ?? "GET",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}`, ...options.headers },
        body: options.body,
      }),
      uiEnv,
    );
  }

  /** The enroll page's shown secret (the or_enter_secret line's payload). */
  function shownSecret(html: string): string {
    const match = /Or enter the secret: ([A-Z2-7]+)/.exec(html);
    expect(match).not.toBe(null);
    return match![1]!;
  }

  it("gates the enroll page: anonymous 303, already-enrolled 303, fresh render carries the stash", async () => {
    const user = await seedVerifiedUser({ username: "Tosha" });

    // Anonymous: the settings prologue 303s onto the login round-trip.
    const bounce = await fetchUi("/user/settings/security/two_factor/enroll");
    expect(bounce.status).toBe(303);
    expect(bounce.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/user/settings/security/two_factor/enroll")}`,
    );

    // The fresh enroll render: the otpauth URI + the secret line, and the
    // signed enroll stash riding Set-Cookie.
    const cookie = await mintSession(env.DB, user.id);
    const fresh = await fetchAuthed("/user/settings/security/two_factor/enroll", cookie);
    expect(fresh.status).toBe(200);
    const html = await fresh.text();
    expect(html).toContain('class="page-content user settings twofa"');
    expect(html).toContain('action="/user/settings/security/two_factor/enroll"');
    expect(html).toContain("otpauth://totp/");
    const secret = shownSecret(html);
    expect(secret.length).toBeGreaterThanOrEqual(16);
    const stash = fresh.headers.get("set-cookie") ?? "";
    expect(stash).toContain("gitea_twofa=");

    // A carried stash re-renders the SAME secret with no fresh stash (the
    // begin/reuse arm — the invalid-passcode 303's re-render substrate).
    const stashValue = stash.split(";")[0]!.split("=").slice(1).join("=");
    const reuse = await fetchAuthed("/user/settings/security/two_factor/enroll", cookie, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}; gitea_twofa=${stashValue}` },
    });
    expect(reuse.status).toBe(200);
    expect(shownSecret(await reuse.text())).toBe(secret);
    expect(reuse.headers.get("set-cookie")).toBeNull();

    // The already-enrolled refusal: an enrolled doer 303s the canonical
    // security page (upstream's `t != nil` pre-check arm).
    const secret2 = generateTotpSecret();
    const enrolled = await applyTwofaEnrollment(
      env.DB,
      user.id,
      await totpCode(secret2, Math.floor(Date.now() / 1000)),
      await mintPendingTicket(env.DB, { kind: "enroll", secret: secret2 }),
    );
    expect(enrolled.outcome).toBe("enrolled");
    const refused = await fetchAuthed("/user/settings/security/two_factor/enroll", cookie);
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe("/user/settings/security");
  });

  it("enrolls end-to-end over the route: valid passcode activates, invalid 303s back to the same secret", async () => {
    const user = await seedVerifiedUser({ username: "Tosha" });
    const cookie = await mintSession(env.DB, user.id);

    // Begin: capture the shown secret + stash.
    const fresh = await fetchAuthed("/user/settings/security/two_factor/enroll", cookie);
    const html = await fresh.text();
    const secret = shownSecret(html);
    const stash = (fresh.headers.get("set-cookie") ?? "").split(";")[0]!.split("=").slice(1).join("=");

    // The invalid passcode: 303 back onto the GET (the plain-form reduction).
    const formHeaders = { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" };
    const invalid = await fetchAuthed("/user/settings/security/two_factor/enroll", cookie, {
      method: "POST",
      headers: { ...formHeaders, cookie: `${SESSION_COOKIE_NAME}=${cookie}; gitea_twofa=${stash}` },
      body: "passcode=000000",
    });
    expect(invalid.status).toBe(303);
    expect(invalid.headers.get("location")).toBe("/user/settings/security/two_factor/enroll");
    expect(await drizzle(env.DB).select().from(twoFactor).all()).toHaveLength(0);

    // The valid passcode: verify-once activates; the security page re-renders
    // at 200 with the once-shown scratch token in the positive notice.
    const now = Math.floor(Date.now() / 1000);
    const code = await totpCode(secret, now);
    const enroll = await fetchAuthed("/user/settings/security/two_factor/enroll", cookie, {
      method: "POST",
      headers: { ...formHeaders, cookie: `${SESSION_COOKIE_NAME}=${cookie}; gitea_twofa=${stash}` },
      body: `passcode=${code}`,
    });
    expect(enroll.status).toBe(200);
    const enrolledHtml = await enroll.text();
    expect(enrolledHtml).toContain("successfully enrolled");
    expect(enrolledHtml).toContain("Store your single-use recovery key (");
    // The enrolled arm clears the enroll stash (the twofaSubmit twin's
    // clearTwofaSetCookie arm) — the sealed ticket still CARRIES the TOTP
    // secret, so the activated state must not leave it browser-live.
    expect(enroll.headers.get("set-cookie") ?? "").toContain(clearTwofaSetCookie());
    const row = await drizzle(env.DB).select().from(twoFactor).all();
    expect(row).toHaveLength(1);
    expect(row[0]!.userId).toBe(user.id);
    expect(row[0]!.secret).toBe(secret);
  });

  it("regenerates the scratch token and disables over the routes, with the code requirement", async () => {
    const user = await seedVerifiedUser({ username: "Tosha" });
    const cookie = await mintSession(env.DB, user.id);
    const formHeaders = { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" };

    // Enroll directly through the seam (the route covered above), keeping
    // the once-shown scratch token for the later disable arm.
    const secret = generateTotpSecret();
    const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret });
    const enrolled = await applyTwofaEnrollment(env.DB, user.id, await totpCode(secret, Math.floor(Date.now() / 1000)), ticket);
    expect(enrolled.outcome).toBe("enrolled");
    const firstScratch = enrolled.outcome === "enrolled" ? enrolled.scratchToken : "";

    // Regenerate: 200 re-render with the once-shown token; the not-enrolled
    // miss arm 303s back (covered by the row's presence here).
    const regen = await fetchAuthed("/user/settings/security/two_factor/regenerate_scratch", cookie, {
      method: "POST",
      headers: formHeaders,
    });
    expect(regen.status).toBe(200);
    const regenHtml = await regen.text();
    expect(regenHtml).toContain("Your single-use recovery key is now ");
    expect(regenHtml).not.toContain(firstScratch);

    // Disable with a WRONG code: the negative notice re-render, the row STAYS.
    const wrong = await fetchAuthed("/user/settings/security/two_factor/disable", cookie, {
      method: "POST",
      headers: formHeaders,
      body: "passcode=000000",
    });
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain("The passcode is incorrect. Try again.");
    expect(await drizzle(env.DB).select().from(twoFactor).all()).toHaveLength(1);

    // Disable with a valid passcode: 303 the canonical URL, the row gone.
    const code = await totpCode(secret, Math.floor(Date.now() / 1000));
    const disable = await fetchAuthed("/user/settings/security/two_factor/disable", cookie, {
      method: "POST",
      headers: formHeaders,
      body: `passcode=${code}`,
    });
    expect(disable.status).toBe(303);
    expect(disable.headers.get("location")).toBe("/user/settings/security");
    expect(await drizzle(env.DB).select().from(twoFactor).all()).toHaveLength(0);
  });

  it("arms the write guards: the cross-origin reject and the two GET 405 twins", async () => {
    const user = await seedVerifiedUser({ username: "Tosha" });
    const cookie = await mintSession(env.DB, user.id);

    // The §2.8 sameOriginGuard rides the prologue's write mode.
    const forged = await fetchAuthed("/user/settings/security/two_factor/regenerate_scratch", cookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);

    // The POST-only tails' GET twins answer chi's 405 (Allow: POST).
    for (const path of [
      "/user/settings/security/two_factor/regenerate_scratch",
      "/user/settings/security/two_factor/disable",
    ]) {
      const twin = await fetchAuthed(path, cookie);
      expect(twin.status, path).toBe(405);
      expect(twin.headers.get("allow")).toBe("POST");
      expect(await twin.text()).toBe("Method Not Allowed\n");
    }
  });
});

// --- the account-link unlink POST (the W5 handoff route — the 1b17b08
// --- referral's parse-reachability fix: the settings security page's Remove
// --- form 404'd through the dispatcher until the parse claim landed) ---------

describe("POST /user/settings/security/account_link (the W5 unlink route)", () => {
  async function fetchAuthed(
    path: string,
    cookie: string | null,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
          ...options.headers,
        },
        body: options.body,
      }),
      uiEnv,
    );
  }

  /** One linked identity over the landed store seams (the security page
   *  matrix's fixture shape): an active OAuth2 source + the doer's
   *  external_login_user row. Answers the source id — the Remove form's
   *  hidden `id` field carries it (the unlink keys on the pair). */
  async function seedLink(userId: number): Promise<number> {
    const cfg = serializeOAuth2SourceConfig({
      v: 1,
      provider: "openidConnect",
      clientId: "client-id",
      clientSecret: "client-secret",
      discoveryUrl: "https://idp.example.com",
    });
    const source = await createLoginSource(env.DB, {
      type: LoginSourceType.OAuth2,
      name: "oidc-corp",
      isActive: true,
      cfg,
    });
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId, provider: "openidConnect" });
    return source.id;
  }

  it("gates the POST: anonymous 303s the login round-trip", async () => {
    const bounce = await fetchAuthed("/user/settings/security/account_link", null, {
      method: "POST",
      body: "id=7",
    });
    expect(bounce.status).toBe(303);
    expect(bounce.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/user/settings/security/account_link")}`,
    );
  });

  it("unlinks over the live POST: the form id removes the pair and 303s back; the stale id re-renders the notice", async () => {
    const user = await seedVerifiedUser({ username: "Lorna" });
    const cookie = await mintSession(env.DB, user.id);
    const sourceId = await seedLink(user.id);
    const formHeaders = { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" };

    // The Remove form's exact shape (the page render's hidden id): 303 onto
    // the canonical security page, the external_login_user row gone.
    const unlink = await fetchAuthed("/user/settings/security/account_link", cookie, {
      method: "POST",
      headers: formHeaders,
      body: `id=${sourceId}`,
    });
    expect(unlink.status).toBe(303);
    expect(unlink.headers.get("location")).toBe("/user/settings/security");
    expect(await drizzle(env.DB).select().from(externalLoginUsers).all()).toHaveLength(0);

    // The re-POST of the now-gone id (security.go:55-57's arm through the
    // route): the 200 re-render carries the missing-link notice — no 500.
    const stale = await fetchAuthed("/user/settings/security/account_link", cookie, {
      method: "POST",
      headers: formHeaders,
      body: `id=${sourceId}`,
    });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain("was not found");
  });

  it("arms the write guards: the cross-origin 403 and the GET 405 twin", async () => {
    const user = await seedVerifiedUser({ username: "Lorna" });
    const cookie = await mintSession(env.DB, user.id);

    // The §2.8 sameOriginGuard rides the prologue's write mode.
    const forged = await fetchAuthed("/user/settings/security/account_link", cookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);

    // The POST-only family's GET twin answers chi's 405 (Allow: POST).
    const twin = await fetchAuthed("/user/settings/security/account_link", cookie);
    expect(twin.status).toBe(405);
    expect(twin.headers.get("allow")).toBe("POST");
    expect(await twin.text()).toBe("Method Not Allowed\n");
  });
});

// --- the admin-user-edit route (the cd6ea38 referral's placement fix — the
// --- claim was brace-nested inside the detail arm and never reachable) --------

describe("GET /-/admin/users/{id}/edit (the placement fix's route pin)", () => {
  async function fetchAuthed(
    path: string,
    cookie: string | null,
  ): Promise<Response> {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, {
        headers: cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      }),
      uiEnv,
    );
  }

  it("answers the be89414 gate ladder: anonymous 303, non-admin 404, admin 200", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });

    // Anonymous: the admin prologue 303s onto the login round-trip.
    const bounce = await fetchAuthed(`/-/admin/users/${alice.id}/edit`, null);
    expect(bounce.status).toBe(303);
    expect(bounce.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/-/admin/users/${alice.id}/edit`)}`,
    );

    // The signed-in non-admin: the hidden admin surface 404-shells.
    const peon = await seedVerifiedUser({ username: "Peon" });
    const peonCookie = await mintSession(env.DB, peon.id);
    const forbidden = await fetchAuthed(`/-/admin/users/${alice.id}/edit`, peonCookie);
    expect(forbidden.status).toBe(404);
    expect(await forbidden.text()).toContain("<title>Page Not Found - cf-gitea</title>");

    // The admin: the edit page renders over the seeded row.
    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });
    const adminCookie = await mintSession(env.DB, admin.id);
    const ok = await fetchAuthed(`/-/admin/users/${alice.id}/edit`, adminCookie);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain(`action="/-/admin/users/${alice.id}/edit" method="post"`);
  });

  it("an unknown id 303s the admin list (the handler's miss arm through the now-reachable route)", async () => {
    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });
    const cookie = await mintSession(env.DB, admin.id);
    const miss = await fetchAuthed("/-/admin/users/999999/edit", cookie);
    expect(miss.status).toBe(303);
    expect(miss.headers.get("location")).toBe("/-/admin/users");
  });
});

// --- the five dead-route fixes' route pins (the deep review's F1-F5, fixed
// --- 2026-11-01): each family's registration + parse claim verified END TO
// --- END over seeded rows — the request must reach the HANDLER, not just
// --- parse -------------------------------------------------------------------

describe("the five dead-route fixes' route pins", () => {
  /** The verb/header-carrying fetch (the fetchAuthed shape + method/body). */
  async function fetchAs(
    path: string,
    cookie: string | null,
    options: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
          ...options.headers,
        },
        body: options.body,
      }),
      uiEnv,
    );
  }

  /** A same-origin urlencoded POST body (the write ladders' convention). */
  const urlEncoded = (body: Record<string, string>): { method: string; headers: Record<string, string>; body: string } => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
    body: new URLSearchParams(body).toString(),
  });

  /** The F1/F2 fixture: Alice + a package version + a linked-target repo. */
  async function seedOwnerFixture(): Promise<{ aliceId: number; cookie: string }> {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await seedPackageVersion(alice.id, "proj", "1.0.0", new Date(1_700_000_000 * 1000));
    await seedRepo("alice", "hello");
    return { aliceId: alice.id, cookie: await mintSession(env.DB, alice.id) };
  }

  it("F1: GET /{owner}/-/packages/settings/{type}/{name} renders the settings page (settings FIRST — the :version GET no longer absorbs it)", async () => {
    const { cookie } = await seedOwnerFixture();

    // The owner writer: the write-gated page renders (the breadcrumb's
    // settings title; the link form's action carries the settings-FIRST url).
    const page = await fetchAs("/alice/-/packages/settings/generic/proj", cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>proj - cf-gitea</title>");
    // The rendered forms carry the DISPLAY owner name (the rows fold case at
    // resolution, every owner-scoped family's convention).
    expect(html).toContain('action="/Alice/-/packages/settings/generic/proj"');

    // Anonymous: the write gate 404-shells (upstream reqPackageAccess(write)).
    const anon = await fetchAs("/alice/-/packages/settings/generic/proj", null);
    expect(anon.status).toBe(404);
  });

  it("F1: POST the settings link action 303s onto the settings-first url (the version-delete POST shape stays method-disambiguated)", async () => {
    const { cookie } = await seedOwnerFixture();

    const link = await fetchAs("/alice/-/packages/settings/generic/proj", cookie, urlEncoded({ action: "link", repo_name: "hello" }));
    expect(link.status).toBe(303);
    expect(link.headers.get("location")).toBe("/Alice/-/packages/settings/generic/proj");

    // Anonymous POST: the login round-trip (the submit's doer check precedes
    // the write gate, the landed handler ladder).
    const anon = await fetchAs("/alice/-/packages/settings/generic/proj", null, urlEncoded({ action: "link", repo_name: "hello" }));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/-/packages/settings/generic/proj")}`,
    );
  });

  it("F2: POST /{owner}/{repo}/upload-file stages a file for a writer (200 + uuid) and 404-shells anonymous; upload-remove answers 204", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");
    const cookie = await mintSession(env.DB, alice.id);

    // The writer: the multipart body stages into REPO_PACKS and answers the
    // dropzone's JSON ({uuid}) — the request REACHED the handler through the
    // parse claim (before the fix the dispatcher handed it to the engine).
    const form = new FormData();
    form.set("file", new File(["staged bytes"], "drop.txt", { type: "text/plain" }));
    const staged = await fetchAs("/alice/hello/upload-file", cookie, { method: "POST", body: form });
    expect(staged.status).toBe(200);
    const { uuid } = await staged.json<{ uuid: string }>();
    expect(uuid).not.toBe("");

    // The remove twin: the uuid-carrying form answers upstream's
    // missing-tolerant 204 (same-origin; the guard fronts this endpoint).
    const removed = await fetchAs("/alice/hello/upload-remove", cookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
      body: new URLSearchParams({ file: uuid }).toString(),
    });
    expect(removed.status).toBe(204);

    // Anonymous: the handler's writer predicate 404-shells (upstream's
    // MustBeAbleToUpload + reqRepoCodeWriter pair; the POST reach itself is
    // the fix's proof).
    const anonForm = new FormData();
    anonForm.set("file", new File(["x"], "x.txt", { type: "text/plain" }));
    const anon = await fetchAs("/alice/hello/upload-file", null, { method: "POST", body: anonForm });
    expect(anon.status).toBe(404);
  });

  it("F3: DELETE /{owner}/{repo}/issues/unpin/{index} unpins the seeded pin (204, the unpin comment lands); the GET twin answers chi's 405", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");
    const repo = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, "hello")).get();
    if (repo === undefined) throw new Error("seed repo missing");
    await drizzle(env.DB).insert(issues).values({ repoId: repo.id, index: 1, title: "pinned", posterId: alice.id, createdAt: new Date(1_700_000_000 * 1000) });
    const issue = await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).get();
    if (issue === undefined) throw new Error("seed issue missing");
    await drizzle(env.DB).insert(issuePins).values({ issueId: issue.id, repoId: repo.id, pinOrder: 1 });
    const cookie = await mintSession(env.DB, alice.id);

    // The admin (owner) DELETE: 204, the pin row gone, the unpin system
    // comment written — through the VERB-FIRST route (web.go:1404).
    const unpin = await fetchAs("/alice/hello/issues/unpin/1", cookie, {
      method: "DELETE",
      headers: { origin: "https://test.local" },
    });
    expect(unpin.status).toBe(204);
    const pin = await drizzle(env.DB).select({ id: issuePins.issueId }).from(issuePins).where(eq(issuePins.issueId, issue.id)).get();
    expect(pin).toBeUndefined();
    const unpinComment = await drizzle(env.DB).select({ id: comments.id }).from(comments).where(eq(comments.issueId, issue.id)).get();
    expect(unpinComment).toBeDefined();

    // The GET twin answers chi's 405 with Allow: DELETE.
    const twin = await fetchAs("/alice/hello/issues/unpin/1", null);
    expect(twin.status).toBe(405);
    expect(twin.headers.get("allow")).toBe("DELETE");

    // Anonymous DELETE: the admin gate's login 303.
    const anon = await fetchAs("/alice/hello/issues/unpin/1", null, {
      method: "DELETE",
      headers: { origin: "https://test.local" },
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/alice/hello/issues/unpin/1")}`);
  });

  it("F4: POST /{owner}/{repo}/issues/{index}/times/{timeid}/delete soft-deletes the entry (303 onto the canonical issue); a missing timeid 404s", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await seedRepo("alice", "hello");
    const repo = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, "hello")).get();
    if (repo === undefined) throw new Error("seed repo missing");
    await drizzle(env.DB).insert(issues).values({ repoId: repo.id, index: 1, title: "timed", posterId: alice.id, createdAt: new Date(1_700_000_000 * 1000) });
    const issue = await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).get();
    if (issue === undefined) throw new Error("seed issue missing");
    await drizzle(env.DB).insert(trackedTimes).values({ issueId: issue.id, userId: alice.id, seconds: 3600, createdAt: new Date(1_700_000_000 * 1000) });
    const entry = await drizzle(env.DB).select({ id: trackedTimes.id }).from(trackedTimes).where(eq(trackedTimes.issueId, issue.id)).get();
    if (entry === undefined) throw new Error("seed time entry missing");
    const cookie = await mintSession(env.DB, alice.id);

    // The owner POST through the FOUR-segment route (web.go:1379): the
    // canonical 303, the row soft-deleted.
    const del = await fetchAs(`/alice/hello/issues/1/times/${entry.id}/delete`, cookie, urlEncoded({}));
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe("/alice/hello/issues/1");
    const deleted = await drizzle(env.DB).select({ deleted: trackedTimes.deleted }).from(trackedTimes).where(eq(trackedTimes.id, entry.id)).get();
    expect(deleted?.deleted).toBe(true);

    // A missing timeid: the handler's 404 shell (the row lookup misses).
    const miss = await fetchAs("/alice/hello/issues/1/times/9999/delete", cookie, urlEncoded({}));
    expect(miss.status).toBe(404);
  });
});


// ---------------------------------------------------------------------------
// The O1 org membership write families (web.go:989 + 997-998) — parse
// claims, the member-level gate ladder, the permission matrices and the
// no-flash 303 reductions, over the mounted uiRouter with minted sessions.
// The file's beforeEach truncates the tables between tests, so every test
// seeds its own org through the landed OrgService/TeamsService arms the
// handlers compose (the F4 fixture pattern).
// ---------------------------------------------------------------------------

describe("O1 org membership write families (web.go:989 + 997-998)", () => {
  const T0 = 1_700_000_000;

  async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
    return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
  }

  async function sessionHeader(userId: number): Promise<string> {
    return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
  }

  const formPost = (path: string, body: Record<string, string>, cookie?: string, origin = "https://test.local"): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(body).toString(),
  });

  /** The shared org fixture: owner, two Developers members, an outsider, a
   *  site admin, the Developers team, and two org repos for the grant
   *  arms. Answered per test (the truncate-and-reseed convention). */
  async function seedOrgFixture(): Promise<{
    ownerId: number;
    memberId: number;
    member2Id: number;
    outsiderId: number;
    orgId: number;
    teamId: number;
    repoIds: string[];
  }> {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "o1-owner" });
    const member = await seedVerifiedUser({ username: "o1-member" });
    const member2 = await seedVerifiedUser({ username: "o1-member2" });
    const outsider = await seedVerifiedUser({ username: "o1-outsider" });
    const org = await orgs.createOrg({ name: "o1-org", ownerId: owner.id, visibility: "public", now: new Date(T0 * 1000) });
    const teams = new TeamsService(env.DB);
    const team = await teams.createTeam(org, { name: "Developers", permission: "write" });
    await teams.addTeamMember(team, member.id);
    await teams.addTeamMember(team, member2.id);
    const repoIds: string[] = [];
    for (const slug of ["o1repo", "o1repo2"]) {
      const id = crypto.randomUUID();
      repoIds.push(id);
      await drizzle(env.DB).insert(repositories).values({
        id,
        storageKey: `r_${id}`,
        ownerNamespace: "o1-org",
        ownerId: org.id,
        slug,
        visibility: "private",
      });
    }
    return { ownerId: owner.id, memberId: member.id, member2Id: member2.id, outsiderId: outsider.id, orgId: org.id, teamId: team.id, repoIds };
  }

  /** The last-owner org: a solo owner on their own only team. */
  async function seedSoloOrgFixture(): Promise<{ ownerId: number; orgId: number; teamId: number }> {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "o1-solo" });
    const org = await orgs.createOrg({ name: "o1-solo-org", ownerId: owner.id, visibility: "public", now: new Date(T0 * 1000) });
    const team = await new TeamsService(env.DB).createTeam(org, { name: "Solo", permission: "read" });
    await new TeamsService(env.DB).addTeamMember(team, owner.id);
    return { ownerId: owner.id, orgId: org.id, teamId: team.id };
  }

  const teamAction = (action: string, teamId: number): string => `/o1-org/teams/${teamId}/action/${action}`;

  it("claims the action shapes with both team carriers and the wildcard action", () => {
    expect(parseUiRoute("/acme/teams/42/action/join")).toEqual({ family: "org-team-action", owner: "acme", id: 42, action: "join" });
    expect(parseUiRoute("/acme/teams/007/action/join")).toEqual({ family: "org-team-action", owner: "acme", id: 7, action: "join" });
    expect(parseUiRoute("/acme/teams/devs/action/leave")).toEqual({ family: "org-team-action", owner: "acme", name: "devs", action: "leave" });
    expect(parseUiRoute("/acme/teams/42/action/repo/add")).toEqual({ family: "org-team-repo-action", owner: "acme", id: 42, action: "add" });
    expect(parseUiRoute("/acme/teams/42/action/repo/remove-all")).toEqual({ family: "org-team-repo-action", owner: "acme", id: 42, action: "remove-all" });
    expect(parseUiRoute("/org/acme/members/action/leave")).toEqual({ family: "org-members-action", owner: "acme", action: "leave" });
    // The wave-12 flip: the previously-unclaimed tail is this battery's
    // family (the pages-wave12.test.ts pin carries the same assertion).
    expect(handlesUiRoute("/acme/teams/42/action/join")).toBe(true);
    // The repo literal is CLAIMED at the 6-segment shape as the wildcard
    // action "repo" (upstream's path param: TeamsAction's switch falls the
    // unknown token through to the default redirect) — only the 7-segment
    // literal pair is the repo family.
    expect(parseUiRoute("/acme/teams/42/action/repo")).toEqual({ family: "org-team-action", owner: "acme", id: 42, action: "repo" });
  });

  it("leaves the malformed and adjacent tails with the engine", () => {
    // Junk-encoded segments decode nowhere (the parser's per-segment rule).
    expect(parseUiRoute("/acme/teams/%zz/action/join")).toBeNull();
    expect(parseUiRoute("/acme/teams/42/action/%zz")).toBeNull();
    expect(parseUiRoute("/acme/teams/42/action/repo/%zz")).toBeNull();
    expect(parseUiRoute("/org/acme/members/action/%zz")).toBeNull();
    // The literal `action` segment and the exact segment counts only.
    expect(parseUiRoute("/acme/teams/42/action")).toBeNull();
    expect(parseUiRoute("/acme/teams/42/actions/join")).toBeNull();
    expect(parseUiRoute("/acme/teams/42/action/repo/add/extra")).toBeNull();
    expect(parseUiRoute("/org/acme/members/action")).toBeNull();
    expect(parseUiRoute("/org/acme/members/extra")).toBeNull();
    expect(parseUiRoute("/org/acme/members/action/leave/extra")).toBeNull();
  });

  it("owner adds a member (the org membership rides AddTeamMember) and a member leaving their only team drops it", async () => {
    const fx = await seedOrgFixture();
    const teams = new TeamsService(env.DB);
    const orgs = new OrgService(env.DB);
    const ownerCookie = await sessionHeader(fx.ownerId);
    const candidate = await seedVerifiedUser({ username: "o1-candidate" });

    const added = await fetchUi(teamAction("add", fx.teamId), formPost(teamAction("add", fx.teamId), { uname: "O1-Candidate" }, ownerCookie));
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe(`/o1-org/teams/${fx.teamId}`);
    expect(await teams.isTeamMember(fx.teamId, candidate.id)).toBe(true);
    // AddTeamMember ensured the ORG membership ("user will have membership
    // to given organization automatically").
    expect(await orgs.getMembership(fx.orgId, candidate.id)).not.toBeNull();

    // The member leaves: the row goes, and with no remaining team the org
    // membership goes too — the public-org arm of
    // checkIsOrgMemberAndRedirect lands on the org home.
    const leave = await fetchUi(teamAction("leave", fx.teamId), formPost(teamAction("leave", fx.teamId), { uid: String(fx.member2Id) }, await sessionHeader(fx.member2Id)));
    expect(leave.status).toBe(303);
    expect(leave.headers.get("location")).toBe("/o1-org");
    expect(await teams.isTeamMember(fx.teamId, fx.member2Id)).toBe(false);
    expect(await orgs.getMembership(fx.orgId, fx.member2Id)).toBeNull();
  });

  it("gates the write ladder: outsider 404s, plain member cannot join/add/remove, off-team member 404s", async () => {
    const fx = await seedOrgFixture();
    const memberCookie = await sessionHeader(fx.memberId);
    const outsiderCookie = await sessionHeader(fx.outsiderId);

    // A signed-in NON-member is upstream's RequireMember NotFound.
    const stranger = await fetchUi(teamAction("add", fx.teamId), formPost(teamAction("add", fx.teamId), { uname: "o1-outsider" }, outsiderCookie));
    expect(stranger.status).toBe(404);
    // A team member (non-owner) hits the IsOwner arms: join/add/remove 404.
    for (const [action, body] of [
      ["join", {}],
      ["add", { uname: "o1-outsider" }],
      ["remove", { uid: String(fx.member2Id) }],
    ] as const) {
      const res = await fetchUi(teamAction(action, fx.teamId), formPost(teamAction(action, fx.teamId), body, memberCookie));
      expect(res.status).toBe(404);
    }
    // An org member NOT on this team 404s at RequireTeamMember.
    const orgs = new OrgService(env.DB);
    const other = await seedVerifiedUser({ username: "o1-other-team" });
    await orgs.addMember(fx.orgId, other.id, { now: new Date(T0 * 1000) });
    const offTeam = await fetchUi(teamAction("leave", fx.teamId), formPost(teamAction("leave", fx.teamId), {}, await sessionHeader(other.id)));
    expect(offTeam.status).toBe(404);
    // Non-member join: join is not open self-service upstream either.
    const join = await fetchUi(teamAction("join", fx.teamId), formPost(teamAction("join", fx.teamId), {}, outsiderCookie));
    expect(join.status).toBe(404);
  });

  it("owner joins and self-leaves; zero/unknown uid redirects to the teams list; unknown action falls through", async () => {
    const fx = await seedOrgFixture();
    const teams = new TeamsService(env.DB);
    const ownerCookie = await sessionHeader(fx.ownerId);

    // Join: the owner adds THEMSELVES to the team.
    const join = await fetchUi(teamAction("join", fx.teamId), formPost(teamAction("join", fx.teamId), { page: "team", uid: String(fx.ownerId) }, ownerCookie));
    expect(join.status).toBe(303);
    expect(join.headers.get("location")).toBe("/o1-org/teams");
    expect(await teams.isTeamMember(fx.teamId, fx.ownerId)).toBe(true);
    // ...and their own leave attempt is the last-owner refusal (the sole
    // role='owner' row, no remaining team): nothing is deleted and the
    // redirect ladder keeps the default teams-list target.
    const leave = await fetchUi(teamAction("leave", fx.teamId), formPost(teamAction("leave", fx.teamId), { uid: String(fx.ownerId) }, ownerCookie));
    expect(leave.status).toBe(303);
    expect(leave.headers.get("location")).toBe("/o1-org/teams");
    expect(await teams.isTeamMember(fx.teamId, fx.ownerId)).toBe(true);

    // Remove with a zero uid: upstream's user==nil arm → the teams list.
    const zero = await fetchUi(teamAction("remove", fx.teamId), formPost(teamAction("remove", fx.teamId), { uid: "0" }, ownerCookie));
    expect(zero.status).toBe(303);
    expect(zero.headers.get("location")).toBe("/o1-org/teams");
    // Remove with an unknown uid: the same arm.
    const ghost = await fetchUi(teamAction("remove", fx.teamId), formPost(teamAction("remove", fx.teamId), { uid: "999999" }, ownerCookie));
    expect(ghost.status).toBe(303);
    expect(ghost.headers.get("location")).toBe("/o1-org/teams");
    // The owner removing a member: the 303 lands on the team slice (the
    // still-member ladder) and the row goes.
    const removed = await fetchUi(teamAction("remove", fx.teamId), formPost(teamAction("remove", fx.teamId), { uid: String(fx.member2Id) }, ownerCookie));
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe(`/o1-org/teams/${fx.teamId}`);
    expect(await teams.isTeamMember(fx.teamId, fx.member2Id)).toBe(false);
    // An unknown action token: the wildcard's default redirect.
    const unknown = await fetchUi(teamAction("promote", fx.teamId), formPost(teamAction("promote", fx.teamId), {}, ownerCookie));
    expect(unknown.status).toBe(303);
    expect(unknown.headers.get("location")).toBe("/o1-org/teams");
    // An unknown REPO action token: the repo family's default.
    const unknownRepo = await fetchUi(`${teamAction("repo", fx.teamId)}/swap`, formPost(`${teamAction("repo", fx.teamId)}/swap`, {}, ownerCookie));
    expect(unknownRepo.status).toBe(303);
    expect(unknownRepo.headers.get("location")).toBe(`/o1-org/teams/${fx.teamId}`);
  });

  it("the last-owner team leave refusal keeps the team row and lands on the teams list", async () => {
    const fx = await seedSoloOrgFixture();
    const teams = new TeamsService(env.DB);
    const leave = await fetchUi(`/o1-solo-org/teams/${fx.teamId}/action/leave`, formPost(`/o1-solo-org/teams/${fx.teamId}/action/leave`, {}, await sessionHeader(fx.ownerId)));
    expect(leave.status).toBe(303);
    // Still a member (refused) → the default teams list.
    expect(leave.headers.get("location")).toBe("/o1-solo-org/teams");
    expect(await teams.isTeamMember(fx.teamId, fx.ownerId)).toBe(true);
  });

  it("add resolves unknown/org targets to the team redirect and never writes", async () => {
    const fx = await seedOrgFixture();
    const teams = new TeamsService(env.DB);
    const ownerCookie = await sessionHeader(fx.ownerId);

    const ghost = await fetchUi(teamAction("add", fx.teamId), formPost(teamAction("add", fx.teamId), { uname: "o1-nobody" }, ownerCookie));
    expect(ghost.status).toBe(303);
    expect(ghost.headers.get("location")).toBe(`/o1-org/teams/${fx.teamId}`);
    // An ORG row is the cannot_add_org_to_team arm (users.type='org').
    const orgRow = await fetchUi(teamAction("add", fx.teamId), formPost(teamAction("add", fx.teamId), { uname: "o1-org" }, ownerCookie));
    expect(orgRow.status).toBe(303);
    expect(await teams.isTeamMember(fx.teamId, fx.orgId)).toBe(false);
  });

  it("repo grants: add by name, the nonexistent arm, remove, addall, removeall", async () => {
    const fx = await seedOrgFixture();
    const teams = new TeamsService(env.DB);
    const team = await teams.getTeamById(fx.teamId);
    if (team === null) throw new Error("seed team missing");
    const ownerCookie = await sessionHeader(fx.ownerId);
    const repoAction = (action: string): string => `${teamAction("repo", fx.teamId)}/${action}`;

    // A NON-member cannot touch the grants (the owner gate before the
    // switch, teams.go:272-275).
    const stranger = await fetchUi(repoAction("add"), formPost(repoAction("add"), { repo_name: "o1repo" }, await sessionHeader(fx.outsiderId)));
    expect(stranger.status).toBe(404);

    // Unknown repo: the nonexistent arm redirects without a grant.
    const ghost = await fetchUi(repoAction("add"), formPost(repoAction("add"), { repo_name: "teamorg/nope" }, ownerCookie));
    expect(ghost.status).toBe(303);
    expect(ghost.headers.get("location")).toBe(`/o1-org/teams/${fx.teamId}`);

    // Add by name (the search box's org/repo form base-strips).
    const add = await fetchUi(repoAction("add"), formPost(repoAction("add"), { repo_name: "o1-org/o1repo" }, ownerCookie));
    expect(add.status).toBe(303);
    expect(await teams.hasTeamRepo(team, fx.repoIds[0]!)).toBe(true);

    // Addall covers the rest of the org.
    const addall = await fetchUi(repoAction("addall"), formPost(repoAction("addall"), {}, ownerCookie));
    expect(addall.status).toBe(303);
    for (const repoId of fx.repoIds) expect(await teams.hasTeamRepo(team, repoId)).toBe(true);

    // Remove the pair grant, then removeall clears the rest.
    const remove = await fetchUi(repoAction("remove"), formPost(repoAction("remove"), { repoid: fx.repoIds[0]! }, ownerCookie));
    expect(remove.status).toBe(303);
    expect(await teams.hasTeamRepo(team, fx.repoIds[0]!)).toBe(false);
    const removeall = await fetchUi(repoAction("removeall"), formPost(repoAction("removeall"), {}, ownerCookie));
    expect(removeall.status).toBe(303);
    for (const repoId of fx.repoIds) expect(await teams.hasTeamRepo(team, repoId)).toBe(false);
  });

  it("members family: owner removes (the team sweep included), non-owner 404s, leave lands on the site root", async () => {
    const fx = await seedOrgFixture();
    const orgs = new OrgService(env.DB);
    const teams = new TeamsService(env.DB);
    // Fresh members — this test owns their whole lifecycle.
    const sweptUser = await seedVerifiedUser({ username: "o1-swept" });
    const leaver = await seedVerifiedUser({ username: "o1-leaver" });
    await orgs.addMember(fx.orgId, sweptUser.id, { now: new Date((T0 + 100) * 1000) });
    const team = await teams.getTeamById(fx.teamId);
    if (team === null) throw new Error("seed team missing");
    await teams.addTeamMember(team, sweptUser.id);
    await orgs.addMember(fx.orgId, leaver.id, { now: new Date((T0 + 110) * 1000) });
    const membersAction = (action: string): string => `/org/o1-org/members/action/${action}`;

    // A non-owner member cannot remove another member.
    const forbidden = await fetchUi(membersAction("remove"), formPost(membersAction("remove"), { uid: String(sweptUser.id) }, await sessionHeader(leaver.id)));
    expect(forbidden.status).toBe(404);

    // The owner removes: the org row goes AND the team sweep takes every
    // team_members row of the org with it.
    const removed = await fetchUi(membersAction("remove"), formPost(membersAction("remove"), { uid: String(sweptUser.id) }, await sessionHeader(fx.ownerId)));
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/org/o1-org/members");
    expect(await orgs.getMembership(fx.orgId, sweptUser.id)).toBeNull();
    const sweptRows = await drizzle(env.DB).select({ id: teamMembers.id }).from(teamMembers).where(eq(teamMembers.userId, sweptUser.id)).all();
    expect(sweptRows).toHaveLength(0);

    // Leave: the JSONRedirect("/") arm.
    const leave = await fetchUi(membersAction("leave"), formPost(membersAction("leave"), { uid: String(leaver.id) }, await sessionHeader(leaver.id)));
    expect(leave.status).toBe(303);
    expect(leave.headers.get("location")).toBe("/");
    expect(await orgs.getMembership(fx.orgId, leaver.id)).toBeNull();
  });

  it("members family: the last-owner leave refusal keeps the row and reloads the page; unknown action reloads; junk uid 404s; anonymous 303s", async () => {
    const fx = await seedSoloOrgFixture();
    const orgs = new OrgService(env.DB);
    const action = (token: string): string => `/org/o1-solo-org/members/action/${token}`;

    const refused = await fetchUi(action("leave"), formPost(action("leave"), { uid: String(fx.ownerId) }, await sessionHeader(fx.ownerId)));
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe("/org/o1-solo-org/members");
    expect(await orgs.getMembership(fx.orgId, fx.ownerId)).not.toBeNull();

    // Unknown action: upstream's switch fall-through answers JSONOK (the
    // stay-on-page arm) — the form port reloads the members page.
    const unknown = await fetchUi(action("promote"), formPost(action("promote"), { uid: String(fx.ownerId) }, await sessionHeader(fx.ownerId)));
    expect(unknown.status).toBe(303);
    expect(unknown.headers.get("location")).toBe("/org/o1-solo-org/members");

    // A junk/zero uid: upstream's GetUserByID 404.
    const junk = await fetchUi(action("remove"), formPost(action("remove"), { uid: "abc" }, await sessionHeader(fx.ownerId)));
    expect(junk.status).toBe(404);

    // Anonymous: the action families' login 303.
    const anon = await fetchUi(action("leave"), formPost(action("leave"), { uid: String(fx.ownerId) }));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");
  });

  it("members family: the visibility flips ride self-or-owner (ChangeOrgUserStatus's guard)", async () => {
    const fx = await seedOrgFixture();
    const orgs = new OrgService(env.DB);
    const selfUser = await seedVerifiedUser({ username: "o1-vis-self" });
    const otherUser = await seedVerifiedUser({ username: "o1-vis-other" });
    const looker = await seedVerifiedUser({ username: "o1-vis-looker" });
    await orgs.addMember(fx.orgId, selfUser.id, { isPublic: false, now: new Date((T0 + 200) * 1000) });
    await orgs.addMember(fx.orgId, otherUser.id, { isPublic: false, now: new Date((T0 + 210) * 1000) });
    await orgs.addMember(fx.orgId, looker.id, { isPublic: false, now: new Date((T0 + 220) * 1000) });
    const membersAction = (action: string): string => `/org/o1-org/members/action/${action}`;
    const isPublic = async (userId: number): Promise<boolean | undefined> => {
      const row = await drizzle(env.DB).select({ isPublic: orgMembers.isPublic }).from(orgMembers).where(eq(orgMembers.userId, userId)).get();
      return row?.isPublic;
    };

    // The member flips their OWN row public, then back.
    const selfPublic = await fetchUi(membersAction("public"), formPost(membersAction("public"), { uid: String(selfUser.id) }, await sessionHeader(selfUser.id)));
    expect(selfPublic.status).toBe(303);
    expect(await isPublic(selfUser.id)).toBe(true);
    const selfPrivate = await fetchUi(membersAction("private"), formPost(membersAction("private"), { uid: String(selfUser.id) }, await sessionHeader(selfUser.id)));
    expect(selfPrivate.status).toBe(303);
    expect(await isPublic(selfUser.id)).toBe(false);

    // A non-owner member cannot flip someone else's row.
    const forbidden = await fetchUi(membersAction("public"), formPost(membersAction("public"), { uid: String(otherUser.id) }, await sessionHeader(looker.id)));
    expect(forbidden.status).toBe(404);
    expect(await isPublic(otherUser.id)).toBe(false);

    // The owner flips anyone's.
    const ownerFlip = await fetchUi(membersAction("public"), formPost(membersAction("public"), { uid: String(otherUser.id) }, await sessionHeader(fx.ownerId)));
    expect(ownerFlip.status).toBe(303);
    expect(await isPublic(otherUser.id)).toBe(true);
  });

  it("armors the families: cross-origin 403 and the GET twins' chi 405", async () => {
    const fx = await seedOrgFixture();
    const ownerCookie = await sessionHeader(fx.ownerId);
    const evil = (path: string): RequestInit => formPost(path, {}, ownerCookie, "https://evil.example");
    for (const path of [
      teamAction("add", fx.teamId),
      `${teamAction("repo", fx.teamId)}/add`,
      "/org/o1-org/members/action/remove",
    ]) {
      const res = await fetchUi(path, evil(path));
      expect(res.status).toBe(403);
    }
    for (const path of [
      teamAction("join", fx.teamId),
      `${teamAction("repo", fx.teamId)}/add`,
      "/org/o1-org/members/action/leave",
    ]) {
      const twin = await fetchUi(path, { method: "GET", headers: { cookie: ownerCookie } });
      expect(twin.status).toBe(405);
      expect(twin.headers.get("allow")).toBe("POST");
    }
  });
});

// ---------------------------------------------------------------------------
// The follow-up bundle's route battery (2026-11-01): the update_preferences
// KV write, the org heatmap twins, the editor underscore aliases, the
// settings danger threading (doer + env) and the delete redirect override,
// and the admin repos delete write.
// ---------------------------------------------------------------------------

describe("POST /user/settings/update_preferences (web.go:636)", () => {
  async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
    return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
  }

  async function sessionHeader(userId: number): Promise<string> {
    return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
  }

  async function storedFlag(userId: number): Promise<string | undefined> {
    const row = await drizzle(env.DB)
      .select({ settingValue: userSettingsKv.settingValue })
      .from(userSettingsKv)
      .where(and(eq(userSettingsKv.userId, userId), eq(userSettingsKv.settingKey, "code_view.show_file_tree")))
      .get();
    return row?.settingValue;
  }

  it("stores the flag for a signed-in user and answers JSONOK; the toggle flips the stored bytes", async () => {
    const user = await seedVerifiedUser({ username: "pref-user" });
    const cookie = await sessionHeader(user.id);
    const post = (body: string): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://test.local", cookie },
      body,
    });

    const hide = await fetchUi("/user/settings/update_preferences", post(JSON.stringify({ codeViewShowFileTree: false })));
    expect(hide.status).toBe(200);
    expect(await hide.text()).toBe('{"ok":true}');
    expect(await storedFlag(user.id)).toBe("false");

    const show = await fetchUi("/user/settings/update_preferences", post(JSON.stringify({ codeViewShowFileTree: true })));
    expect(show.status).toBe(200);
    // the upsert arbitrated at the (user_id, setting_key) unique — one row, new bytes
    const rows = await drizzle(env.DB).select().from(userSettingsKv).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.settingValue).toBe("true");
    expect(rows[0]?.settingKey).toBe("code_view.show_file_tree");
    expect(rows[0]?.userId).toBe(user.id);
  });

  it("a missing field stores Go's zero (false); unknown fields are ignored", async () => {
    const user = await seedVerifiedUser({ username: "pref-user2" });
    const cookie = await sessionHeader(user.id);
    const res = await fetchUi("/user/settings/update_preferences", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://test.local", cookie },
      body: JSON.stringify({ somethingElse: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await storedFlag(user.id)).toBe("false");
  });

  it("a malformed body and a wrong-typed field are the 400 json-decode arm", async () => {
    const user = await seedVerifiedUser({ username: "pref-user3" });
    const cookie = await sessionHeader(user.id);
    const bad = await fetchUi("/user/settings/update_preferences", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://test.local", cookie },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    const wrongType = await fetchUi("/user/settings/update_preferences", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://test.local", cookie },
      body: JSON.stringify({ codeViewShowFileTree: "yes" }),
    });
    expect(wrongType.status).toBe(400);
    const rows = await drizzle(env.DB).select().from(userSettingsKv).all();
    expect(rows).toHaveLength(0); // nothing written on either refusal
  });

  it("an anonymous POST 303s onto the login round-trip (reqSignIn) and a GET twin answers chi's 405", async () => {
    const anon = await fetchUi("/user/settings/update_preferences", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://test.local" },
      body: "{}",
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/user/settings/update_preferences")}`,
    );
    const twin = await fetchUi("/user/settings/update_preferences", { method: "GET" });
    expect(twin.status).toBe(405);
    expect(twin.headers.get("allow")).toBe("POST");
  });
});

describe("GET /org/{org}/dashboard/-/heatmap[/{team}] (web.go:984-985)", () => {
  const T0 = 1_700_000_000;

  async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
    return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
  }

  async function sessionHeader(userId: number): Promise<string> {
    return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
  }

  /** The org fixture: an owner, a team member (on Developers), a plain org
   *  member (no team), and an outsider. */
  async function seedFixture(): Promise<{ orgId: number; ownerId: number; teamMemberId: number; memberId: number; outsiderId: number; teamId: number }> {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "hm-owner" });
    const teamMember = await seedVerifiedUser({ username: "hm-teammember" });
    const member = await seedVerifiedUser({ username: "hm-member" });
    const outsider = await seedVerifiedUser({ username: "hm-outsider" });
    const org = await orgs.createOrg({ name: "hm-org", ownerId: owner.id, visibility: "public", now: new Date(T0 * 1000) });
    await orgs.addMember(org.id, member.id, { now: new Date(T0 * 1000) }); // the plain member: no team
    await orgs.addMember(org.id, teamMember.id, { now: new Date(T0 * 1000) }); // RequireMember's row
    const teams = new TeamsService(env.DB);
    const team = await teams.createTeam(org, { name: "Developers", permission: "read" });
    await teams.addTeamMember(team, teamMember.id);
    return { orgId: org.id, ownerId: owner.id, teamMemberId: teamMember.id, memberId: member.id, outsiderId: outsider.id, teamId: team.id };
  }

  it("serves the pair-shape JSON to a member and 404-shells anonymous and non-members", async () => {
    const fx = await seedFixture();

    const anon = await fetchUi("/org/hm-org/dashboard/-/heatmap");
    expect(anon.status).toBe(404); // RequireMember — NO login redirect

    const outsider = await fetchUi("/org/hm-org/dashboard/-/heatmap", {
      headers: { cookie: await sessionHeader(fx.outsiderId) },
    });
    expect(outsider.status).toBe(404);

    const member = await fetchUi("/org/hm-org/dashboard/-/heatmap", {
      headers: { cookie: await sessionHeader(fx.memberId) },
    });
    expect(member.status).toBe(200);
    expect(member.headers.get("content-type")).toContain("application/json");
    expect(await member.json()).toEqual({ heatmapData: [], totalContributions: 0 });
  });

  it("the {team} tail resolves case-folded behind RequireTeamMember; a miss shells", async () => {
    const fx = await seedFixture();

    // The plain member is not on Developers — RequireTeamMember's shell.
    const offTeam = await fetchUi("/org/hm-org/dashboard/-/heatmap/developers", {
      headers: { cookie: await sessionHeader(fx.memberId) },
    });
    expect(offTeam.status).toBe(404);

    // The team member passes (the case-folded lower-name resolution).
    const onTeam = await fetchUi("/org/hm-org/dashboard/-/heatmap/DEVELOPERS", {
      headers: { cookie: await sessionHeader(fx.teamMemberId) },
    });
    expect(onTeam.status).toBe(200);
    expect(await onTeam.json()).toEqual({ heatmapData: [], totalContributions: 0 });

    // An unknown team name shells like the page family's resolution arm.
    const ghost = await fetchUi("/org/hm-org/dashboard/-/heatmap/ghost", {
      headers: { cookie: await sessionHeader(fx.ownerId) },
    });
    expect(ghost.status).toBe(404);
  });
});

describe("the editor underscore aliases (web.go:1453-1467)", () => {
  async function fetchUi(path: string): Promise<Response> {
    return uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
  }

  it("each underscore spelling reaches the editor's anonymous arm (the login 303), not the engine 404", async () => {
    await seedVerifiedUser({ username: "alias-owner" });
    await seedRepo("alias-owner", "aliased");
    for (const path of [
      "/alias-owner/aliased/_new/main",
      "/alias-owner/aliased/_edit/main/x.txt",
      "/alias-owner/aliased/_delete/main/x.txt",
      "/alias-owner/aliased/_upload/main",
      "/alias-owner/aliased/_diffpatch/main",
    ]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe(
        `/login?redirect_to=${encodeURIComponent(path)}`,
      );
    }
  });
});

describe("settingsSubmit's danger threading (the doer + env tails) and the delete redirect override", () => {
  async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
    return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
  }

  async function sessionHeader(userId: number): Promise<string> {
    return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
  }

  const formPost = (path: string, body: Record<string, string>, cookie: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local", cookie },
    body: new URLSearchParams(body).toString(),
  });

  it("the delete arm redirects onto the owner dashboard: / for a user owner, /org/{name}/dashboard for an org owner", async () => {
    const admin = await seedVerifiedUser({ username: "del-admin", isAdmin: true });
    const owner = await seedVerifiedUser({ username: "del-owner" }); // the org twin's creator
    await seedRepo("del-owner", "goner");
    const cookie = await sessionHeader(admin.id);

    const res = await fetchUi(
      "/del-owner/goner/settings",
      formPost("/del-owner/goner/settings", { action: "delete", repo_name: "del-owner/goner" }, cookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/"); // user.DashboardLink() — AppSubURL + "/"
    const rows = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).all();
    expect(rows).toHaveLength(0);

    // The org-owned twin: OrganisationLink() + "/dashboard".
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "del-org", ownerId: owner.id, visibility: "public", now: new Date() });
    const orgRepoId = crypto.randomUUID();
    await drizzle(env.DB).insert(repositories).values({
      id: orgRepoId,
      storageKey: `r_${orgRepoId}`,
      ownerNamespace: "del-org",
      ownerId: org.id,
      slug: "orgrepo",
      visibility: "public",
    });
    const orgRes = await fetchUi(
      "/del-org/orgrepo/settings",
      formPost("/del-org/orgrepo/settings", { action: "delete", repo_name: "del-org/orgrepo" }, cookie),
    );
    expect(orgRes.status).toBe(303);
    expect(orgRes.headers.get("location")).toBe("/org/del-org/dashboard");
    const after = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).all();
    expect(after).toHaveLength(0);
  });

  it("the transfer arm records the SESSION user as the pending doer (the threaded viewer, not the repo owner)", async () => {
    const admin = await seedVerifiedUser({ username: "xfer-admin", isAdmin: true });
    await seedVerifiedUser({ username: "xfer-owner" });
    const target = await seedVerifiedUser({ username: "xfer-target" });
    await seedRepo("xfer-owner", "movable");
    const cookie = await sessionHeader(admin.id);

    const res = await fetchUi(
      "/xfer-owner/movable/settings",
      formPost("/xfer-owner/movable/settings", { action: "transfer", repo_name: "xfer-owner/movable", new_owner_name: "xfer-target" }, cookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/xfer-owner/movable/settings");
    const pending = await drizzle(env.DB).select().from(repoTransfer).all();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.doerId).toBe(admin.id); // the session viewer — the unthreaded call recorded the OWNER
    expect(pending[0]?.newOwnerId).toBe(target.id);
  });
});

describe("POST /-/admin/repos/delete (web.go:851)", () => {
  async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
    return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
  }

  async function sessionHeader(userId: number): Promise<string> {
    return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
  }

  it("deletes the row for a site admin and 303s back onto the list; unknown ids 303 silently; the GET twin 405s", async () => {
    const admin = await seedVerifiedUser({ username: "adm-del-admin", isAdmin: true });
    await seedVerifiedUser({ username: "adm-del-owner" });
    await seedRepo("adm-del-owner", "adm-goner");
    const seeded = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).all();
    expect(seeded).toHaveLength(1);
    const repoId = seeded[0]?.id as string;
    const cookie = await sessionHeader(admin.id);

    const twin = await fetchUi("/-/admin/repos/delete", { method: "GET" });
    expect(twin.status).toBe(405);
    expect(twin.headers.get("allow")).toBe("POST");

    const ghost = await fetchUi("/-/admin/repos/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local", cookie },
      body: new URLSearchParams({ id: "no-such-repo" }).toString(),
    });
    expect(ghost.status).toBe(303); // the stale-form arm — silent
    expect(ghost.headers.get("location")).toBe("/-/admin/repos");

    const res = await fetchUi("/-/admin/repos/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local", cookie },
      body: new URLSearchParams({ id: repoId }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/-/admin/repos");
    const after = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).all();
    expect(after).toHaveLength(0);
  });

  it("a non-admin POST 404-shells (the prologue's gate)", async () => {
    const plain = await seedVerifiedUser({ username: "adm-del-plain" });
    const res = await fetchUi("/-/admin/repos/delete", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://test.local",
        cookie: await sessionHeader(plain.id),
      },
      body: new URLSearchParams({ id: "whatever" }).toString(),
    });
    expect(res.status).toBe(404);
  });
});

// --- the wiki commit-diff downloads (web.go:1620 — the PageIsWiki RawDiff
//     arm over the SIBLING `owner/slug.wiki` cell; grammar + loader in
//     pages/wiki-commit-diff.tsx, the serving branch in wikiPage) ----------

describe("GET /{owner}/{repo}/wiki/commit/{sha}.{diff|patch} (the raw serving arm)", () => {
  // The CELL write lands once (DO storage outlives the D1 beforeEach sweep —
  // the same persistence the smoke suite's memoized fixtures ride); the D1
  // pair re-seeds per test because beforeEach wipes users/repositories.
  let wikiCellSeed: { sha: string; entry: string } | null = null;

  /** A wiki cell with one real commit: the page write seam (the same
   *  service ops the form POSTs ride — the §4.4 gate blocks git-http
   *  seeding of `*.wiki` cells), the fixture identity the route's own
   *  prologue would derive for this user. */
  async function seedWikiCommit(): Promise<{ sha: string; entry: string }> {
    await seedVerifiedUser({ username: "wikidl-alice" });
    await seedRepo("wikidl-alice", "wikidl");
    const repoRow =
      (await drizzle(env.DB)
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "wikidl-alice"), eq(repositories.slug, "wikidl")))
        .get()) ?? null;
    if (repoRow === null) throw new Error("wikidl repo row missing");
    const owner =
      (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "wikidl-alice")).get()) ?? null;
    if (owner === null) throw new Error("wikidl owner row missing");
    const pair: RepositoryWithOwner = { repo: repoRow, owner };
    if (wikiCellSeed === null) {
      const created = await createWikiPageFromForm(
        env,
        pair,
        { name: "wikidl-alice", email: "wikidl-alice@noreply.test.local" },
        parseWikiPageForm(new URLSearchParams({ title: "Serving Arm", content: "one\ntwo\n", message: "serving arm commit" })),
        "https://test.local",
      );
      expect(created.sub_url).toBe("Serving-Arm");
      const tip = await wikiTipOf(env, pair);
      if (tip === undefined) throw new Error("wiki tip missing");
      wikiCellSeed = { sha: tip.target, entry: "Serving-Arm.md" };
    }
    return wikiCellSeed;
  }

  it("serves the .diff raw bytes with the diffpatch family's response shape (git-apply-valid body)", async () => {
    const { sha, entry } = await seedWikiCommit();
    const res = await fetchUi(`/wikidl-alice/wikidl/wiki/commit/${sha}.diff`);
    expect(res.status).toBe(200);
    // The diffpatch convention: sniffed plain text + the zero-option prod
    // Cache-Control (diffPatchTextResponse's header pair).
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const body = await res.text();
    // The stored flat entry name in the headers, new-file shape, and a
    // count-consistent hunk (the renderer's git-apply validity).
    expect(body.startsWith(`diff --git a/${entry} b/${entry}\n`)).toBe(true);
    expect(body).toContain("new file mode 100644");
    expect(body).toContain("--- /dev/null");
    expect(body).toContain(`+++ b/${entry}`);
    expect(body).toMatch(/^@@ -0,0 \+1,2 @@$/m);
    expect(body).toContain("+one");
    expect(body).toContain("+two");
  });

  it("serves the .patch raw bytes (the git-am mail without the signature tail)", async () => {
    const { sha, entry } = await seedWikiCommit();
    const res = await fetchUi(`/wikidl-alice/wikidl/wiki/commit/${sha}.patch`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body.startsWith(`From ${sha} Mon Sep 17 00:00:00 2001\n`)).toBe(true);
    expect(body).toContain("From: wikidl-alice <wikidl-alice@noreply.test.local>");
    expect(body).toContain("Subject: [PATCH] serving arm commit");
    expect(body).toContain(`diff --git a/${entry}`);
    expect(body.includes("\n-- \n")).toBe(false); // --no-signature parity (diff.go:73)
  });

  it("404-shells a well-shaped sha the wiki engine cannot resolve (commit.go's IsErrNotExist → ctx.NotFound arm)", async () => {
    await seedWikiCommit();
    const res = await fetchUi(`/wikidl-alice/wikidl/wiki/commit/${"c".repeat(40)}.diff`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("<title>Page Not Found - wikidl-alice/wikidl</title>");
    expect(html).toContain('<div class="status-page-error">');
  });

  it("keeps the pattern misses on the page-name 303 fold (the regression pin)", async () => {
    await seedWikiCommit();
    for (const tail of [
      "commit/zzz.diff", // non-hex sha
      "commit/zzz.patch",
      `commit/${"a".repeat(40)}.diffx`, // suffix beyond the grammar
      `commit/${"A".repeat(40)}.diff`, // uppercase hex — the lowercase-only pattern class
      `commit/${"a".repeat(6)}.diff`, // below the 7-hex floor
    ]) {
      const res = await fetchUi(`/wikidl-alice/wikidl/wiki/${tail}`);
      expect(res.status, tail).toBe(303);
      expect(res.headers.get("location"), tail).toBe("/wikidl-alice/wikidl/wiki/?action=_pages");
    }
  });

  it("keeps the VIEW arm on the PageIsWiki commit page (the serving arm's re-pin)", async () => {
    const { sha } = await seedWikiCommit();
    const res = await fetchUi(`/wikidl-alice/wikidl/wiki/commit/${sha}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The commit-page discriminator (commit_page.tmpl:5) + the WIKI commit
    // base for the sha labels (commit_page.tmpl:2's Iif).
    expect(html).toContain('class="page-content repository diff"');
    expect(html).toContain("serving arm commit");
    expect(html).toContain(`href="/wikidl-alice/wikidl/wiki/commit/${sha}"`);
  });
});

describe("the run-viewer write quartet (web.go:1588, 1590, 1597-1598 — the rerun trio + approve)", () => {
  const T0 = new Date(1_700_000_000 * 1000);
  const PAYLOAD = new TextEncoder().encode("jobs: {}\n");
  const WORKFLOW_ID = ".github/workflows/ci.yml";
  const COMMIT = "ccccdddddddddddddddddddddddddddddddddddd";

  async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
    return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
  }

  async function sessionHeader(userId: number): Promise<string> {
    return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
  }

  /** Alice the owner-writer + bob the signed-in non-writer + the repo with
   *  the actions unit ON (the C2 gate's repo_settings.has_actions row — the
   *  missing row defaults false, the gate 404s before the writer check) and
   *  NON-empty (the schema's is_empty defaults TRUE — a fresh repo is empty
   *  until the first push — and the C2 gate's MustBeNotEmpty arm 404-shells
   *  an empty repo before every later arm). */
  async function seedFixture(): Promise<{ aliceId: number; bobId: number; repoId: string }> {
    const alice = await seedVerifiedUser({ username: "run-alice" });
    const bob = await seedVerifiedUser({ username: "run-bob" });
    await seedRepo("run-alice", "demo");
    await drizzle(env.DB).update(repositories).set({ isEmpty: false }).where(eq(repositories.slug, "demo"));
    const repo = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, "demo")).get();
    if (repo === undefined) throw new Error("seed repo missing");
    await drizzle(env.DB).insert(repoSettings).values({ repoId: repo.id, hasActions: true });
    return { aliceId: alice.id, bobId: bob.id, repoId: repo.id };
  }

  /** A done run through the LANDED insert (attempt 1 + its jobs), forced
   *  onto per-job terminal shapes: success stays/gets 1, failure gets 2. */
  async function seedDoneRun(
    repoId: string,
    ownerId: number,
    index: number,
    jobs: Array<{ jobId: string; needs?: string[]; status: number }>,
  ): Promise<{ runId: number; attemptId: number; jobIds: number[] }> {
    const seeded = await insertActionRun(
      env.DB,
      {
        repoId,
        ownerId,
        workflowId: WORKFLOW_ID,
        index,
        triggerUserId: ownerId,
        ref: "refs/heads/main",
        commitSha: COMMIT,
        event: "push",
        eventPayload: "{}",
        triggerEvent: "push",
      },
      jobs.map((job) => ({ jobId: job.jobId, needs: job.needs, workflowPayload: PAYLOAD })),
    );
    const aggregate = jobs.some((job) => job.status === ACTION_STATUS_FAILURE) ? ACTION_STATUS_FAILURE : ACTION_STATUS_SUCCESS;
    await drizzle(env.DB).update(actionRuns).set({ status: aggregate }).where(eq(actionRuns.id, seeded.run.id));
    await drizzle(env.DB).update(actionRunAttempts).set({ status: aggregate }).where(eq(actionRunAttempts.id, seeded.attempt.id));
    for (const [i, job] of jobs.entries()) {
      await drizzle(env.DB)
        .update(actionRunJobs)
        .set({ status: job.status, started: T0, stopped: new Date(T0.getTime() + 1000) })
        .where(eq(actionRunJobs.id, seeded.jobRows[i]!.id));
    }
    return { runId: seeded.run.id, attemptId: seeded.attempt.id, jobIds: seeded.jobRows.map((row) => row.id) };
  }

  const post = (cookie: string | null, origin = "https://test.local"): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie === null ? {} : { cookie }),
    },
    body: "{}",
  });

  it("parses the four POST shapes and leaves the delete sibling engine-owned", () => {
    expect(parseUiRoute("/alice/demo/actions/runs/7/rerun")).toEqual({
      family: "actions-run-rerun",
      owner: "alice",
      repo: "demo",
      run: "7",
    });
    expect(parseUiRoute("/alice/demo/actions/runs/7/rerun-failed")).toEqual({
      family: "actions-run-rerun-failed",
      owner: "alice",
      repo: "demo",
      run: "7",
    });
    expect(parseUiRoute("/alice/demo/actions/runs/7/approve")).toEqual({
      family: "actions-run-approve",
      owner: "alice",
      repo: "demo",
      run: "7",
    });
    expect(parseUiRoute("/alice/demo/actions/runs/7/jobs/9/rerun")).toEqual({
      family: "actions-run-job-rerun",
      owner: "alice",
      repo: "demo",
      run: "7",
      job: "9",
    });
    // Upstream's unregistered sibling: chi 404s it, the engine keeps it.
    expect(parseUiRoute("/alice/demo/actions/runs/7/delete")).toBeNull();
    // The deeper tail past the job param stays unclaimed (the parser's
    // exact-literal rule).
    expect(parseUiRoute("/alice/demo/actions/runs/7/jobs/9/rerun/extra")).toBeNull();
  });

  it("rerun: the writer POST answers the redirect JSON and lands attempt 2 (the state change)", async () => {
    const fx = await seedFixture();
    const seeded = await seedDoneRun(fx.repoId, fx.aliceId, 1, [
      { jobId: "build", status: ACTION_STATUS_SUCCESS },
      { jobId: "test", needs: ["build"], status: ACTION_STATUS_FAILURE },
    ]);

    const res = await fetchUi(`/run-alice/demo/actions/runs/${seeded.runId}/rerun`, post(await sessionHeader(fx.aliceId)));
    expect(res.status).toBe(200);
    // ctx.JSONRedirect(run.Link()) — the frontend's follow.
    expect(await res.json<{ redirect: string }>()).toEqual({ redirect: `/run-alice/demo/actions/runs/${seeded.runId}` });

    // The state change: attempt 2 exists, latest_attempt_id moved, EVERY
    // job reset (the needs-less one waits, the dependent one pends).
    const attempts = await drizzle(env.DB).select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, seeded.runId));
    expect(attempts).toHaveLength(2);
    const stored = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.runId)).get())!;
    expect(attempts.map((a) => a.id)).toContain(stored.latestAttemptId);
    const attempt2Id = stored.latestAttemptId;
    const attempt2Jobs = await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.runAttemptId, attempt2Id));
    const byKey = new Map(attempt2Jobs.map((job) => [job.jobId, job]));
    expect(byKey.get("build")?.status).toBe(ACTION_STATUS_WAITING);
    expect(byKey.get("test")?.status).toBe(ACTION_STATUS_PENDING);
  });

  it("rerun-failed: only the failed job resets (the succeeded one passes through); a green run 400s the no_failed_jobs JSONError", async () => {
    const fx = await seedFixture();
    const seeded = await seedDoneRun(fx.repoId, fx.aliceId, 1, [
      { jobId: "build", status: ACTION_STATUS_SUCCESS },
      { jobId: "deploy", status: ACTION_STATUS_FAILURE },
    ]);
    const cookie = await sessionHeader(fx.aliceId);

    const res = await fetchUi(`/run-alice/demo/actions/runs/${seeded.runId}/rerun-failed`, post(cookie));
    expect(res.status).toBe(200);
    expect(await res.json<{ redirect: string }>()).toEqual({ redirect: `/run-alice/demo/actions/runs/${seeded.runId}` });

    // The partial rerun's split: deploy resets to waiting, build clones as
    // the pass-through row KEEPING its terminal status.
    const stored = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.runId)).get())!;
    const attempt2Jobs = await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.runAttemptId, stored.latestAttemptId));
    const byKey = new Map(attempt2Jobs.map((job) => [job.jobId, job]));
    expect(byKey.get("deploy")?.status).toBe(ACTION_STATUS_WAITING);
    expect(byKey.get("build")?.status).toBe(ACTION_STATUS_SUCCESS);

    // The green run: the empty failed set is an ERROR, not a rerun-all
    // (view.go:1002-1008) — the JSONError shape, nothing written.
    const green = await seedDoneRun(fx.repoId, fx.aliceId, 2, [{ jobId: "build", status: ACTION_STATUS_SUCCESS }]);
    const refused = await fetchUi(`/run-alice/demo/actions/runs/${green.runId}/rerun-failed`, post(cookie));
    expect(refused.status).toBe(400);
    expect(await refused.json<{ errorMessage: string; renderFormat: string }>()).toEqual({
      errorMessage: "This workflow run has no failed jobs to re-run.",
      renderFormat: "text",
    });
    const greenRun = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, green.runId)).get())!;
    expect(greenRun.latestAttemptId).toBe(green.attemptId); // no attempt 2
  });

  it("job-level rerun: the named job resets on the new attempt; a junk {job} 404-shells (findCurrentJobByPathParam's miss)", async () => {
    const fx = await seedFixture();
    const seeded = await seedDoneRun(fx.repoId, fx.aliceId, 1, [
      { jobId: "build", status: ACTION_STATUS_SUCCESS },
      { jobId: "deploy", status: ACTION_STATUS_FAILURE },
    ]);
    const cookie = await sessionHeader(fx.aliceId);

    const deployJob = seeded.jobIds[1]!;
    const res = await fetchUi(`/run-alice/demo/actions/runs/${seeded.runId}/jobs/${deployJob}/rerun`, post(cookie));
    expect(res.status).toBe(200);
    expect(await res.json<{ redirect: string }>()).toEqual({ redirect: `/run-alice/demo/actions/runs/${seeded.runId}` });

    // The state change: attempt 2, and BOTH the named job and its transitive
    // downstream reset (deploy has no dependents here; build passes through).
    const stored = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.runId)).get())!;
    expect(stored.latestAttemptId).not.toBe(seeded.attemptId);
    const attempt2Jobs = await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.runAttemptId, stored.latestAttemptId));
    const byKey = new Map(attempt2Jobs.map((job) => [job.jobId, job]));
    expect(byKey.get("deploy")?.status).toBe(ACTION_STATUS_WAITING);
    expect(byKey.get("build")?.status).toBe(ACTION_STATUS_SUCCESS);

    // A {job} that parses to 0 (junk) misses the run's job set — the 404
    // shell (view.go:970-974), never a rerun-all.
    // A junk {job} on a STILL-DONE run misses the job set — the 404 shell
    // (view.go:970-974), never a rerun-all. (On this test's own run the
    // pin would read the not-done JSONError 400 first — attempt 2 above is
    // running; upstream checks checkRunRerunAllowed BEFORE the job find.)
    const fresh = await seedDoneRun(fx.repoId, fx.aliceId, 2, [{ jobId: "solo", status: ACTION_STATUS_FAILURE }]);
    const junk = await fetchUi(`/run-alice/demo/actions/runs/${fresh.runId}/jobs/0/rerun`, post(cookie));
    expect(junk.status).toBe(404);
    expect((await junk.text()).includes("Page Not Found")).toBe(true);
  });

  it("approve: the writer POST answers JSONOK, flips the flag, records the approver, and releases the needs-less job", async () => {
    const fx = await seedFixture();
    const seeded = await insertActionRun(
      env.DB,
      {
        repoId: fx.repoId,
        ownerId: fx.aliceId,
        workflowId: WORKFLOW_ID,
        index: 1,
        triggerUserId: fx.aliceId,
        ref: "refs/heads/main",
        commitSha: COMMIT,
        event: "pull_request",
        eventPayload: "{}",
        triggerEvent: "pull_request",
      },
      [{ jobId: "build", workflowPayload: PAYLOAD }],
    );
    // The fork-PR posture: the run awaits approval, its job sits BLOCKED.
    await drizzle(env.DB).update(actionRuns).set({ needApproval: true }).where(eq(actionRuns.id, seeded.run.id));
    await drizzle(env.DB).update(actionRunAttempts).set({ status: 7 }).where(eq(actionRunAttempts.id, seeded.attempt.id));
    await drizzle(env.DB).update(actionRunJobs).set({ status: 7 }).where(eq(actionRunJobs.id, seeded.jobRows[0]!.id));

    const res = await fetchUi(`/run-alice/demo/actions/runs/${seeded.run.id}/approve`, post(await sessionHeader(fx.aliceId)));
    expect(res.status).toBe(200);
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true }); // ctx.JSONOK's dummy

    const stored = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.run.id)).get())!;
    expect(stored.needApproval).toBe(false);
    expect(stored.approvedBy).toBe(fx.aliceId);
    const job = (await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.id, seeded.jobRows[0]!.id)).get())!;
    expect(job.status).toBe(ACTION_STATUS_WAITING);
  });

  it("approve on a non-awaiting run is the silent continue: 200 JSONOK, nothing written", async () => {
    const fx = await seedFixture();
    const seeded = await seedDoneRun(fx.repoId, fx.aliceId, 1, [{ jobId: "build", status: ACTION_STATUS_SUCCESS }]);

    const res = await fetchUi(`/run-alice/demo/actions/runs/${seeded.runId}/approve`, post(await sessionHeader(fx.aliceId)));
    expect(res.status).toBe(200);
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true });
    const stored = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.runId)).get())!;
    expect(stored.approvedBy).toBe(0); // approve.go:36-38 wrote nothing
  });

  it("gates the quartet: anonymous and non-writer 404-shell (RequireUnitWriter's NotFound), cross-origin 403, the GET twins 405", async () => {
    const fx = await seedFixture();
    const seeded = await seedDoneRun(fx.repoId, fx.aliceId, 1, [
      { jobId: "build", status: ACTION_STATUS_SUCCESS },
      { jobId: "deploy", status: ACTION_STATUS_FAILURE },
    ]);
    const paths = [
      `/run-alice/demo/actions/runs/${seeded.runId}/rerun`,
      `/run-alice/demo/actions/runs/${seeded.runId}/rerun-failed`,
      `/run-alice/demo/actions/runs/${seeded.runId}/approve`,
      `/run-alice/demo/actions/runs/${seeded.runId}/jobs/${seeded.jobIds[1]!}/rerun`,
    ];

    for (const path of paths) {
      // Anonymous: the fetch arm 404-shells — never the login 303.
      const anon = await fetchUi(path, post(null));
      expect(anon.status, path).toBe(404);
      // bob: a signed-in non-collaborator on the readable public repo — the
      // writer gate 404-shells the write.
      const bob = await fetchUi(path, post(await sessionHeader(fx.bobId)));
      expect(bob.status, path).toBe(404);
      // The guard fronts the handler: a cross-origin POST 403s before any
      // read.
      const evil = await fetchUi(path, post(await sessionHeader(fx.aliceId), "https://evil.example"));
      expect(evil.status, path).toBe(403);
      // The GET twin answers chi's 405 with Allow: POST.
      const twin = await fetchUi(path, { method: "GET" });
      expect(twin.status, path).toBe(405);
      expect(twin.headers.get("allow"), path).toBe("POST");
    }

    // Nothing wrote through any gated arm: attempt 1 is still the latest,
    // the dispatch wake never fired (the version row is the SEED's own —
    // insertActionRun bumps it for the dispatchable waiting jobs; the gated
    // POSTs leave it).
    const stored = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.runId)).get())!;
    expect(stored.latestAttemptId).toBe(seeded.attemptId);
    const jobs = await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.runId, seeded.runId));
    expect(jobs.every((job) => job.status !== ACTION_STATUS_WAITING)).toBe(true);
  });
});
