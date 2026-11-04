/**
 * The releases family's LAST route-level tails (pages/releases.tsx + the
 * wave-41 download mounts, driven over the mounted uiRouter on the releases
 * matrix abd7130's minted-session pattern — per-test D1 wipe + fresh
 * sessions). abd7130 + waves 20/33/41 own the rest of the family; THIS FILE
 * carries only the arms the grep across those suites leaves unpinned:
 *
 *   - the /releases/latest redirect's TAG SHAPE tails (wave20's 303 carries
 *     the plain `w20-v1`; abd7130 pins only the prerelease-refusal 404): a
 *     stable release whose tag carries a SLASH 303s onto the raw-slash detail
 *     URL (pathEscapeSegments keeps the separators — the detail route
 *     re-parses the same wildcard) and round-trips; a SPACE-carrying tag
 *     303s onto the per-segment-escaped location and decodes back; the
 *     no-releases 404 pair (a non-empty repo with ZERO release rows — the
 *     filtered-empty arm wave20 covers only via its draft-only repo — and
 *     the empty twin's MustBeNotEmpty gate shell);
 *   - the B-55 write tails LANDED (web.go:1521-1524): POST
 *     /releases/generate-notes (repo.GenerateReleaseNotes — pages/
 *     release-notes.ts's pure commit-walk: the first-release full-history
 *     arm's `## What's Changed` + commits/tag changelog bytes, the
 *     previous-tag compare-link bytes, the merged-PR + contributor lines,
 *     the translatable not-found 400s, the form's Required 400) and POST
 *     /releases/attachments + /releases/attachments/remove
 *     (repo.UploadReleaseAttachment / repo.DeleteAttachment — pages/
 *     release-attachment-writes.tsx: the dropzone's `{"uuid"}` contract,
 *     the unlinked releaseId-0 rows, the ServerError 500 class, the
 *     row+object delete). All three sit behind the write group's gates
 *     (anonymous → the login 303 — the dead-link era's anonymous-404 pin
 *     flipped); the GET twins answer chi's 405 (generate-notes,
 *     attachments) and the remove GET stays the SEAM's (its uuid-404 —
 *     no ui GET registration carries it); the remove POST reaches the ui
 *     arm on the live wire through the seam's POST-only pass-through (the
 *     B-55 carve in attachments-serving.ts — its twins suite pins the
 *     standalone shape);
 *   - the claim pins nobody carries: the compare dotted download feeds
 *     (`/compare/{range}.diff|.patch` — index.ts's compare-feed
 *     family; wave13 pins the PAGE shapes only, compare.matrix declines the
 *     feed branch, compare-feeds.test.tsx owns the unmounted module
 *     contract, wave29 owns the commit/pulls dotted twins) — the suffix
 *     strip's precedence over the page family and over the two-dot null,
 *     dotted refnames, the trailing-slash fold;
 *   - KNOWN DIVERGENCE, REPORTED NOT PINNED: upstream's LatestRelease goes
 *     through ctx.Redirect (release.go:357), whose fetch-action arm
 *     (base.go:153-156) answers 200 {"redirect": …} under a non-empty
 *     X-Gitea-Fetch-Action header. The local releaseLatestRedirect answers
 *     a plain 303 — the wave-41 port covered the tree/blob twins only
 *     (fdaeaca: "BOTH redirect twins"). Unreachable through the official
 *     frontend (no template/JS targets the URL), so no assertion pins
 *     either side here; flagged for triage in the wave report.
 *
 * The fixture repo is `relt-owner/relt` (main + the in-git tag v1) with the
 * never-pushed `relt-owner/relt-empty` twin.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { uploadReleaseAsset } from "../../api/services/release-assets";
import { IssuesService, type ReleaseRow } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { pullRequests, releaseAssets, releases, repositories, users } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { RepoRow } from "../ui-context";
import { attachmentsServingRouter } from "../../web/attachments-serving";

// --- the minted-session route harness (the releases-matrix abd7130 pattern) ------

const ORIGIN = "https://test.local";

/** Synthetic manifest shaped like the real Vite output (the shared fixture
 *  shape — deterministic, no build dependence). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the handler, on the
 *  mounted uiRouter with the synthetic manifest; the execution context is
 *  awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The LIVE surface for the `/releases/attachments/{uuid}` shape (the seam
 *  fold): the repo-scoped twin arm on attachmentsServingRouter, same env +
 *  context discipline as fetchUi. */
async function fetchSeam(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await attachmentsServingRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user (the real mintSession path). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A urlencoded POST with an explicit cookie (null = anonymous) and the
 *  same-origin header — the strongest probe for the unmounted tails: an
 *  authenticated same-origin request that still 404s proves the unmount, not
 *  a gate. */
async function postForm(path: string, cookie: string | null, fields: Record<string, string>): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      ...(cookie === null ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// --- fixtures ------------------------------------------------------------------

const T0 = 1_740_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

const RELT_COMMITS: SeedCommit[] = [
  { message: "relt: root", time: T0, files: [{ path: "README.md", content: "# relt\n" }] },
];

interface ReltFixture {
  ownerCookie: string;
  repo: RepoRow;
}

/** The per-test fixture (re-run after every wipe — ensureSeededRepo skips the
 *  pack push once the engine refs exist and re-creates the D1 rows): the
 *  owner, the content repo (main + the in-git tag v1), and the never-pushed
 *  twin for the MustBeNotEmpty arm. No webhook subscriber: these tails assert
 *  absence of writes, never deliveries. */
async function seedReltFixture(): Promise<ReltFixture> {
  const owner = await seedVerifiedUser({ username: "relt-owner" });
  await ensureSeededRepo({
    owner: "relt-owner",
    slug: "relt",
    commits: RELT_COMMITS,
    tags: [{ name: "v1", commitIndex: 0 }],
  });
  const repoRow = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(eq(repositories.ownerNamespace, "relt-owner"))
    .get();
  if (repoRow === undefined || repoRow.slug !== "relt") throw new Error("relt repo row missing");
  if (repoRow.visibility !== "public" || repoRow.isEmpty) {
    // The re-created row (post-wipe) forgets the push-create stamps: the
    // engine refs persist, so pin visibility and the non-empty flag to the
    // real state — the family's MustBeNotEmpty gate reads is_empty.
    await drizzle(env.DB).update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, repoRow.id));
  }
  const empty = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "relt-owner" },
    name: "relt-empty",
    isPrivate: false,
    status: "ready",
  });
  if (empty.visibility !== "public") {
    await drizzle(env.DB).update(repositories).set({ visibility: "public" }).where(eq(repositories.id, empty.id));
  }
  return { ownerCookie: await sessionHeader(owner.id), repo: repoRow };
}

let fixture: ReltFixture | null = null;

async function theFixture(): Promise<ReltFixture> {
  if (fixture === null) fixture = await seedReltFixture();
  return fixture;
}

/** Seed one stable release row through the LANDED create service with a fixed
 *  `now` (the created_unix the latest-ordering reads). */
async function seedRelease(input: {
  repoId: string;
  publisherId: number;
  tagName: string;
  title: string;
  now: Date;
}): Promise<ReleaseRow> {
  return new IssuesService(env.DB).createRelease({
    repoId: input.repoId,
    publisherId: input.publisherId,
    tagName: input.tagName,
    target: "main",
    title: input.title,
    note: "",
    isDraft: false,
    isPrerelease: false,
    now: input.now,
  });
}

/** The owner's user id — looked up fresh (the per-test wipe invalidates ids). */
async function ownerId(): Promise<number> {
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "relt-owner")).get();
  if (row === undefined) throw new Error("relt owner row missing");
  return row.id;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  fixture = null;
  // FK order: leaf rows first, repositories before users (sessions cascade
  // from users — the notifications wipe precedent). release_assets and
  // releases carry no outbound FKs (migration 0002's plain tables).
  for (const table of ["release_assets", "releases", "repo_settings", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the unpinned claim pins -------------------------------------------------------

describe("the unpinned claim pins (compare dotted feeds + the attachments/remove literal)", () => {
  it("claims the compare download feeds' dotted tails (diff/patch), suffix-strip first", () => {
    // The full range forms: the suffix strip beats the page family's `...`
    // scan (index.ts:3176-3181 precedes the separator parse).
    expect(parseUiRoute("/octo/hello/compare/main...feature/x.diff")).toEqual({
      family: "compare-feed",
      owner: "octo",
      repo: "hello",
      ext: "diff",
      segment: "main...feature/x",
    });
    expect(parseUiRoute("/octo/hello/compare/main...feature/x.patch")).toEqual({
      family: "compare-feed",
      owner: "octo",
      repo: "hello",
      ext: "patch",
      segment: "main...feature/x",
    });
    // The page family keeps the dotless shapes (the feed claim never swallows
    // a plain comparison).
    expect(parseUiRoute("/octo/hello/compare/main...feature/x")?.family).toBe("compare");
    // The two-dot family (a page-family NULL) still claims as a feed: the
    // suffix strip runs before the separator scan, so `main..feature.diff` is
    // the feed segment `main..feature` — the documented precedence.
    expect(parseUiRoute("/octo/hello/compare/main..feature.diff")).toEqual({
      family: "compare-feed",
      owner: "octo",
      repo: "hello",
      ext: "diff",
      segment: "main..feature",
    });
    // Dotted refnames survive: only the trailing extension is stripped.
    expect(parseUiRoute("/octo/hello/compare/v1.0...v1.1.patch")).toEqual({
      family: "compare-feed",
      owner: "octo",
      repo: "hello",
      ext: "patch",
      segment: "v1.0...v1.1",
    });
    // The trailing-slash form folds onto the same feed shape (§4.13 trim).
    expect(parseUiRoute("/octo/hello/compare/main...feature.diff/")).toEqual({
      family: "compare-feed",
      owner: "octo",
      repo: "hello",
      ext: "diff",
      segment: "main...feature",
    });
    expect(handlesUiRoute("/octo/hello/compare/main...feature/x.patch")).toBe(true);
  });

  it("claims the B-55 write-tail literals (the POST arms; the GET uuid shape stays the seam's)", () => {
    // THE SEAM FOLD + THE B-55 CARVE: the `/releases/attachments/{uuid}` GET
    // family lives on the shared attachments-serving seam (its repo-scoped
    // twin), but upstream's write tails share the namespace — web.go:1523's
    // upload (the 1-segment literal) and web.go:1524's remove (the 2-segment
    // literal) are POST routes the parser now claims (the live wire's POST
    // remove rides the seam's POST-only pass-through; the GET on the same
    // path is STILL the seam's uuid lookup — the ui parser claims the shape
    // method-agnostically, but no ui GET registration exists, so the live
    // GET never reaches the sub-app: the seam is mounted before uiRouter and
    // the dispatcher carve hands it over first).
    expect(parseUiRoute("/octo/hello/releases/generate-notes")).toEqual({
      family: "release-generate-notes",
      owner: "octo",
      repo: "hello",
    });
    expect(parseUiRoute("/octo/hello/releases/attachments")).toEqual({
      family: "release-attachment-upload",
      owner: "octo",
      repo: "hello",
    });
    expect(parseUiRoute("/octo/hello/releases/attachments/remove")).toEqual({
      family: "release-attachment-remove",
      owner: "octo",
      repo: "hello",
    });
    // The deeper tails stay unclaimed (upstream registers the exact
    // literals only).
    expect(parseUiRoute("/octo/hello/releases/attachments/remove/x")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/generate-notes/x")).toBeNull();
    expect(handlesUiRoute("/octo/hello/releases/attachments/remove")).toBe(true);
    expect(handlesUiRoute("/octo/hello/releases/attachments/remove/x")).toBe(false);
  });
});

// --- the /releases/latest redirect tails ---------------------------------------------

describe("the /releases/latest redirect's tag-shape tails and the no-releases shells", () => {
  it("303s a slash-carrying latest tag onto the raw-slash detail URL and round-trips", async () => {
    const { repo } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "plan/9", title: "Plan nine", now: at(200) });

    // The newest stable carries a slash: the location keeps the raw
    // separators (pathEscapeSegments escapes per segment, "/" stays a
    // separator) and the detail route re-parses the same wildcard.
    const res = await fetchUi("/relt-owner/relt/releases/latest");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/relt-owner/relt/releases/tag/plan/9");

    // The round-trip: the redirect target renders the slash-tag release.
    const detail = await fetchUi("/relt-owner/relt/releases/tag/plan/9");
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("Plan nine");
  });

  it("303s a space-carrying latest tag onto the escaped location and decodes it back", async () => {
    const { repo } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "rel 1.0", title: "Spaced out", now: at(210) });

    const res = await fetchUi("/relt-owner/relt/releases/latest");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/relt-owner/relt/releases/tag/rel%201.0");

    // The escaped space decodes per segment on the way back in.
    const detail = await fetchUi("/relt-owner/relt/releases/tag/rel%201.0");
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("Spaced out");
  });

  it("404-shells the no-releases pair: a non-empty repo with zero rows, and the empty twin's gate", async () => {
    const { ownerCookie } = await theFixture();

    // The non-empty repo BEFORE any release row: the filtered-empty arm of
    // latestReleaseTagOf (wave20's 404 covers the draft-only input shape,
    // abd7130's the prerelease-only — zero rows is the third input).
    expect((await fetchUi("/relt-owner/relt/releases/latest")).status).toBe(404);
    expect((await fetchUi("/relt-owner/relt/releases/latest", { headers: { cookie: ownerCookie } })).status).toBe(404);

    // The never-pushed twin: the MustBeNotEmpty gate shells before the query.
    expect((await fetchUi("/relt-owner/relt-empty/releases/latest")).status).toBe(404);
    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(0);
  });
});

// --- the B-55 mounted write tails (web.go:1521-1524) ----------------------------------

/** A multipart POST the way Dropzone sends it (one `file` part with a
 *  filename; FormData's boundary rides the Content-Type). */
async function postMultipart(path: string, cookie: string | null, filename: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), filename);
  return fetchUi(path, {
    method: "POST",
    headers: { origin: ORIGIN, ...(cookie === null ? {} : { cookie }) },
    body: form,
  });
}

describe("the mounted write tails (web.go:1521-1524 — census B-55)", () => {
  it("generate-notes: the first-release arm walks the full history and links commits/tag", async () => {
    const { ownerCookie } = await theFixture();
    // ZERO release rows → repoReleaseIsEmpty true (notes.go:72-85's
    // non-draft, non-tag count) → the base commit is "" (notes.go:65's bare
    // `rev-list after`) and the changelog line is the GitHub-aligned
    // commits/tag URL (notes.go:56-60).
    const res = await postForm("/relt-owner/relt/releases/generate-notes", ownerCookie, {
      tag_name: "v1",
      tag_target: "main",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toStrictEqual({
      content: "## What's Changed\n\n**Full Changelog**: https://test.local/relt-owner/relt/commits/tag/v1\n",
    });
  });

  it("generate-notes: the merged-PR and contributor lines render from the walk's commit ids", async () => {
    const { repo, ownerCookie } = await theFixture();
    // The fixture's root commit oid (the idempotent re-seed returns the
    // tips) — the PR row binds it as the merge commit so the first-release
    // walk (the ONLY commit in this repo) finds it via
    // GetPullRequestByMergedCommit's `base_repo_id AND merged_commit_id`.
    const { tips } = await ensureSeededRepo({
      owner: "relt-owner",
      slug: "relt",
      commits: RELT_COMMITS,
      tags: [{ name: "v1", commitIndex: 0 }],
    });
    const issue = await new IssuesService(env.DB).createIssue({
      repoId: repo.id,
      title: "relt: root",
      content: "",
      posterId: await ownerId(),
      now: at(20),
    });
    await drizzle(env.DB).insert(pullRequests).values({
      issueId: issue.id,
      index: issue.index,
      headRepoId: repo.id,
      baseRepoId: repo.id,
      headBranch: "feat/root",
      baseBranch: "main",
      hasMerged: true,
      mergedCommitId: tips[0],
      mergedAt: at(30),
    });

    const res = await postForm("/relt-owner/relt/releases/generate-notes", ownerCookie, {
      tag_name: "v1",
      tag_target: "main",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      content:
        "## What's Changed\n" +
        "* relt: root in [#1](https://test.local/relt-owner/relt/pulls/1)\n" +
        "\n" +
        "## Contributors\n" +
        "* @relt-owner\n" +
        "\n" +
        "## New Contributors\n" +
        "* @relt-owner made their first contribution in [#1](https://test.local/relt-owner/relt/pulls/1)\n" +
        "\n" +
        "**Full Changelog**: https://test.local/relt-owner/relt/commits/tag/v1\n",
    });
    // The rows are untouched — the generator is a pure commit-walk (the
    // census row's no-platform-force verdict).
    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(0);
  });

  it("generate-notes: the previous-tag arm labels the compare link; the bare non-first POST answers the translatable 400", async () => {
    const { repo, ownerCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Notes target", now: at(100) });

    // previous_tag "v1" resolves; base == head → the empty `v1..v1` range →
    // the compare-link form (notes.go:203-207's buildReleaseNotesContent
    // tail — the label keeps the raw names, the URL escapes the segments).
    const withPrevious = await postForm("/relt-owner/relt/releases/generate-notes", ownerCookie, {
      tag_name: "v1",
      tag_target: "main",
      previous_tag: "v1",
    });
    expect(withPrevious.status).toBe(200);
    expect(await withPrevious.json()).toStrictEqual({
      content: "## What's Changed\n\n**Full Changelog**: [v1...v1](https://test.local/relt-owner/relt/compare/v1...v1)\n",
    });

    // No previous tag on a non-first release: notes.go:47-49's translatable
    // error carrying the TAG name — ctx.JSONError's 400 text map.
    const bare = await postForm("/relt-owner/relt/releases/generate-notes", ownerCookie, { tag_name: "v1" });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toStrictEqual({
      errorMessage: 'Tag "v1" does not exist in this repository.',
      renderFormat: "text",
    });
  });

  it("generate-notes: the form's Required 400 and the target-not-found translatable 400; the gate's anonymous 303", async () => {
    const { ownerCookie } = await theFixture();
    // GenerateReleaseNotesForm's Required arm → "form.require_error" with
    // the field display name (ctx.HasError → JSONError, release.go:417-420).
    const empty = await postForm("/relt-owner/relt/releases/generate-notes", ownerCookie, {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toStrictEqual({ errorMessage: "Tag Name cannot be empty.", renderFormat: "text" });

    // The unknown tag + unknown target: resolveHeadCommit (notes.go:113-125)
    // falls to the target ref, which misses → the target-not-found error
    // names the REF (the release rows stay empty, so this is the
    // first-release premise — the error still precedes the walk).
    const unknown = await postForm("/relt-owner/relt/releases/generate-notes", ownerCookie, {
      tag_name: "nope",
      tag_target: "nobranch",
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toStrictEqual({
      errorMessage: 'The release target "nobranch" cannot be found.',
      renderFormat: "text",
    });

    // The write group's reqSignIn (web.go:1519's group middleware): the
    // anonymous probe 303s onto the login round-trip — the dead-link era's
    // anonymous-404 pin flipped by the mount.
    const anonymous = await postForm("/relt-owner/relt/releases/generate-notes", null, { tag_name: "v1" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/login?redirect_to=");
  });

  it("mounts the GET twins at chi's 405 (the POST-only upstream registrations)", async () => {
    await theFixture();
    // generate-notes + attachments: no GET route upstream → 405.
    expect((await fetchUi("/relt-owner/relt/releases/generate-notes")).status).toBe(405);
    expect((await fetchUi("/relt-owner/relt/releases/attachments")).status).toBe(405);
    // The remove GET has NO ui registration (upstream's GET answer for the
    // path is the /releases/attachments/{uuid} route — the seam's; direct
    // sub-app probes fall to Hono's 404 default, the live wire never gets
    // here: the seam claims first).
    expect((await fetchUi("/relt-owner/relt/releases/attachments/remove")).status).toBe(404);
  });

  it("upload: the dropzone's multipart `file` part lands unlinked (releaseId 0) and answers {uuid}", async () => {
    const { repo, ownerCookie } = await theFixture();
    const bytes = new TextEncoder().encode("relt dropzone body\n");
    const res = await postMultipart("/relt-owner/relt/releases/attachments", ownerCookie, "notes.txt", bytes);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const body: { uuid: string } = await res.json();
    expect(typeof body.uuid).toBe("string");

    // The row: repo-scoped, RELEASEID 0 (upstream's ReleaseID-0 insert —
    // the seam's unlinked-release arm serves it uploader-only), the family
    // key layout with the 0 id.
    const rows = await drizzle(env.DB)
      .select()
      .from(releaseAssets)
      .where(eq(releaseAssets.uuid, body.uuid))
      .all();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.releaseId).toBe(0);
    expect(row.repoId).toBe(repo.id);
    expect(row.name).toBe("notes.txt");
    expect(row.size).toBe(bytes.byteLength);
    expect(row.r2Key).toBe(`repos/${repo.storageKey}/release-assets/0/${body.uuid}-notes.txt`);
    const stored = await env.REPO_PACKS.get(row.r2Key);
    expect(stored).not.toBeNull();
    expect(await stored!.text()).toBe("relt dropzone body\n");
  });

  it("upload: a non-multipart body is the ServerError class (attachment.go:53-57's 500)", async () => {
    const { ownerCookie } = await theFixture();
    // urlencoded body: FormFile fails (not multipart) → ctx.ServerError's
    // plain-text 500 — the web family's ServerError posture.
    const res = await postForm("/relt-owner/relt/releases/attachments", ownerCookie, { id: "1" });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // The anonymous probe rides the gate's login 303 before the handler.
    expect((await postMultipart("/relt-owner/relt/releases/attachments", null, "x.txt", new Uint8Array(1))).status).toBe(303);
  });

  it("remove: the row-then-object delete answers {uuid}; the miss answers the exact 400 body", async () => {
    const { repo, ownerCookie } = await theFixture();
    // Seed an unlinked row + object the way the upload arm leaves them (the
    // linked-release upload service rejects id 0 — its key gate — so the
    // unlinked shape inserts directly).
    const bytes = new TextEncoder().encode("relt removable\n");
    const uuid = crypto.randomUUID();
    const r2Key = `repos/${repo.storageKey}/release-assets/0/${uuid}-removable.txt`;
    await env.REPO_PACKS.put(r2Key, bytes);
    await drizzle(env.DB).insert(releaseAssets).values({
      uuid,
      repoId: repo.id,
      releaseId: 0,
      uploaderId: await ownerId(),
      name: "removable.txt",
      size: bytes.byteLength,
      downloadCount: 0,
      r2Key,
      createdAt: at(105),
    });
    const seeded = { uuid, r2Key };

    const res = await postForm("/relt-owner/relt/releases/attachments/remove", ownerCookie, { file: seeded.uuid });
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ uuid: seeded.uuid });
    // The row AND the object are gone (DeleteAttachment's order —
    // models/repo/attachment.go:181-211).
    expect(
      (await drizzle(env.DB).select({ id: releaseAssets.id }).from(releaseAssets).where(eq(releaseAssets.uuid, seeded.uuid)).all())
        .length,
    ).toBe(0);
    expect(await env.REPO_PACKS.get(seeded.r2Key)).toBeNull();

    // The miss (GetAttachmentByUUID's not-exist → 400, the exact Error()
    // body — attachment.go:84-88 through ctx.HTTPError's http.Error shape).
    const miss = await postForm("/relt-owner/relt/releases/attachments/remove", ownerCookie, { file: seeded.uuid });
    expect(miss.status).toBe(400);
    expect(miss.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await miss.text()).toBe(`attachment does not exist [id: 0, uuid: ${seeded.uuid}]\n`);
  });

  it("the seam keeps the GET shapes (the remove literal stays the plain-uuid 404; the real asset serves)", async () => {
    const { repo } = await theFixture();
    const seeded = await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Asset host", now: at(100) });
    const bytes = new TextEncoder().encode("relt asset body\n");
    const asset = await uploadReleaseAsset({
      bucket: env.REPO_PACKS,
      d1: env.DB,
      repoId: repo.id,
      storageKey: repo.storageKey,
      releaseId: seeded.id,
      uploaderId: await ownerId(),
      name: "notes.txt",
      content: new Blob([bytes]).stream() as ReadableStream<Uint8Array>,
      multipart: false,
      declaredLength: bytes.byteLength,
      now: at(105),
    });
    // The GET pins STAYED at the seam (the fold): the literal "remove"
    // segment is the plain uuid "remove" — no asset carries it → the seam's
    // plain-text 404; the POST carve changed nothing for GET.
    const removed = await fetchSeam("/relt-owner/relt/releases/attachments/remove");
    expect(removed.status).toBe(404);
    expect(await removed.text()).toBe("Not Found\n");
    // The real asset still serves through the seam's shared pipeline.
    expect((await fetchSeam(`/relt-owner/relt/releases/attachments/${asset.uuid}`)).status).toBe(200);
  });
});
