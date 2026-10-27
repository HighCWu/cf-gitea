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
 *   - the upstream write tails that stay UNMOUNTED (the dead-link rule,
 *     pages/releases.tsx:123-124): POST /releases/generate-notes (web.go:1521
 *     — parser-unclaimed per wave20:310, so the request engine-404s; the
 *     anonymous probe 404s too, never 303ing onto login) and POST
 *     /releases/attachments + /releases/attachments/remove (web.go:1522-1524
 *     — the URL shape lands in the wave-41 GET serve family as the plain
 *     uuid "remove", but the registration is GET-only, index.ts:10005, so
 *     the POSTs 404 at the sub-app with the rows untouched);
 *   - the claim pins nobody carries: the compare dotted download feeds
 *     (`/compare/{range}.diff|.patch` — index.ts:3176-3181's compare-feed
 *     family; wave13 pins the PAGE shapes only, compare.matrix declines the
 *     feed branch, compare-feeds.test.tsx owns the unmounted module
 *     contract, wave29 owns the commit/pulls dotted twins) — the suffix
 *     strip's precedence over the page family and over the two-dot null,
 *     dotted refnames, the trailing-slash fold;
 *   - KNOWN DIVERGENCE, REPORTED NOT PINNED: upstream's LatestRelease goes
 *     through ctx.Redirect (release.go:357), whose fetch-action arm
 *     (base.go:153-156) answers 200 {"redirect": …} under a non-empty
 *     X-Gitea-Fetch-Action header. The local releaseLatestRedirect
 *     (index.ts:7985-7998) answers a plain 303 — the wave-41 port covered
 *     the tree/blob twins only (fdaeaca: "BOTH redirect twins"). Unreachable
 *     through the official frontend (no template/JS targets the URL), so no
 *     assertion pins either side here; flagged for triage in the wave report.
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
import { releaseAssets, releases, repositories, users } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { RepoRow } from "../ui-context";

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

  it("parses the attachments/remove literal into the wave-41 GET serve family (the unmount is method-level)", () => {
    // The write tail's URL shape is a chi single-segment param like any other
    // uuid (web.go:1513's shape): the PARSER claims it as the attachment
    // family — the unmounted write tail diverges at the METHOD level (the
    // GET-only registration below pins the end-to-end).
    expect(parseUiRoute("/octo/hello/releases/attachments/remove")).toEqual({
      family: "release-attachment",
      owner: "octo",
      repo: "hello",
      uuid: "remove",
    });
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

// --- the unmounted upstream write tails -----------------------------------------------

describe("the unmounted write tails (web.go:1521-1524 — the dead-link divergence)", () => {
  it("engine-404s POST /releases/generate-notes — the parser-unclaimed shape, no login round-trip", async () => {
    const { repo, ownerCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Notes target", now: at(100) });

    // Authenticated + same-origin: still the engine's 404 (wave20:310 pins
    // the parser null this falls out of).
    const signed = await postForm("/relt-owner/relt/releases/generate-notes", ownerCookie, {
      tag_name: "v1",
    });
    expect(signed.status).toBe(404);
    // The anonymous probe 404s too — an unmounted tail has no reqSignIn 303.
    expect((await postForm("/relt-owner/relt/releases/generate-notes", null, { tag_name: "v1" })).status).toBe(404);
    // Nothing was written (upstream's arm synthesizes release notes — no
    // local arm exists to write any).
    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(1);
  });

  it("404s the attachment upload/remove POSTs at the sub-app (GET-only registration), rows untouched", async () => {
    const { repo, ownerCookie } = await theFixture();
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

    // web.go:1522-1524's upload/remove writes never landed: the claimed
    // URL shape reaches the sub-app but only GET registrations exist.
    expect((await postForm("/relt-owner/relt/releases/attachments", ownerCookie, { id: String(seeded.id) })).status).toBe(404);
    expect(
      (await postForm("/relt-owner/relt/releases/attachments/remove", ownerCookie, { uuid: asset.uuid })).status,
    ).toBe(404);
    // The rows: the release AND its asset survive the dead links.
    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(1);
    expect(
      (await drizzle(env.DB).select({ id: releaseAssets.id }).from(releaseAssets).where(eq(releaseAssets.releaseId, seeded.id)).all())
        .length,
    ).toBe(1);
    // The GET shape with the literal "remove" segment is the plain uuid
    // "remove" (the claim pin above): no asset carries it → the loader's 404.
    expect((await fetchUi("/relt-owner/relt/releases/attachments/remove")).status).toBe(404);
    // The real asset still serves (the dead POST tails touched nothing).
    expect((await fetchUi(`/relt-owner/relt/releases/attachments/${asset.uuid}`)).status).toBe(200);
  });
});
