/**
 * The releases family's DEFERRED route-level matrix (pages/releases.tsx mounted
 * through uiRouter — the wave-20 route tests in ui/__tests__/pages-wave20.test.ts
 * own the base arms: the list/detail/latest renders, the new form's writer gate
 * and validation re-renders, the published/draft create writes with their
 * webhook rows, and the parser claims; ui/__tests__/pages-wave33-tags-releases-
 * tails.test.ts owns the wave-33 edit/delete arms: the edit GET render + 404s +
 * anon GET, the unconditional edit write + empty-title re-render, the pencil
 * gate, the delete write + ?deleted= flash; ui/__tests__/pages-wave41-downloads-
 * render.test.ts owns the attachment SERVE matrix: the sniffing, the httpcache
 * pair, the draft gate, the foreign-uuid arm). THIS FILE adds the arms those
 * suites do not carry, driven over the mounted uiRouter with the notifications
 * 28b71b9 matrix's minted-session pattern (per-test D1 wipe + fresh sessions):
 *
 *   - the claim pins the family never pinned: the trailing-slash
 *     canonicalization of every literal/wildcard shape, the malformed
 *     percent-encoding catch arms (decodeURIComponent throws → unclaimed →
 *     engine 404) and the deeper tails under the delete/latest/new literals;
 *   - the anon 303s on the wave-33 POST tails (edit + delete — wave20 pinned
 *     only the new arm): the login round-trip carries the POSTED path and
 *     nothing is written;
 *   - the non-writer arms on the edit tails (GET + POST as the read
 *     collaborator) and the archived/empty shells on the write tails;
 *   - the §2.8 cross-origin 403s on ALL THREE POST arms — sameOriginGuard runs
 *     FIRST, so a valid session cookie still 403s and a cookie-less probe 403s
 *     rather than 303ing onto login; the Origin-less Referer fallback rejects a
 *     foreign referer and admits the same-origin one end-to-end;
 *   - the create/edit round-trips over the draft/prerelease flags: a
 *     prerelease-only publish (visible unauthenticated, the orange label, never
 *     Latest), the draft create's detail-page redirect + visibility pair, the
 *     draft→published edit flip (the "published" webhook action + the
 *     published_unix stamp), the published→draft flip (silent — the emit
 *     gate), the plain published edit ("updated"), and the server-side
 *     255-length guards;
 *   - the delete arms at the webhook level: a published delete cascades the
 *     asset rows and emits action "deleted", a draft delete is silent, and the
 *     junk `id` carriers (non-digits, zero, absent) 404-shell before any write;
 *   - the ?delete_error=failed flash render (the ReleasesFlashBlock's negative
 *     arm — the tags page's query-param convention);
 *   - the attachment arm's route gate wave41 could not pin: the disabled
 *     releases unit 404-shells BOTH download tails over an otherwise-servable
 *     asset (the differential the empty-repo arm cannot isolate).
 *
 * Verified upstream contracts carry the module-doc cites from the page module;
 * the fixture repo is `relmx-owner/rel` (main + the in-git tag v1, one
 * `release`-family webhook subscriber) with the never-pushed
 * `relmx-owner/rel-empty` twin for the MustBeNotEmpty arms.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { createRepoHook } from "../../api/services/hooks";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { uploadReleaseAsset } from "../../api/services/release-assets";
import { findReleaseByTag } from "../../api/services/releases";
import { releaseAssets, releases, repositories, users, webhookDeliveries } from "../../db/schema";
import { IssuesService, type ReleaseRow } from "../../issues/service";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { RepoRow } from "../ui-context";

// --- the minted-session route harness (the notifications 28b71b9 pattern) --------

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

/** A urlencoded POST to one of the family's write arms: the explicit cookie
 *  (null = anonymous) and Origin (null = the Origin-less probe) are
 *  independent — the §2.8 guard and the session gate are separate layers, and
 *  the referer arms exercise sameOriginGuard's fallback branch. */
async function postArm(
  path: string,
  cookie: string | null,
  fields: Record<string, string> | null,
  origin: string | null = ORIGIN,
  referer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  if (cookie !== null) headers.cookie = cookie;
  return fetchUi(path, {
    method: "POST",
    headers,
    body: fields === null ? undefined : new URLSearchParams(fields).toString(),
  });
}

// --- fixtures ------------------------------------------------------------------

const T0 = 1_740_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

const RELMX_COMMITS: SeedCommit[] = [
  { message: "relmx: root", time: T0, files: [{ path: "README.md", content: "# relmx\n" }] },
  { message: "relmx: second", time: T0 + 60, files: [{ path: "README.md", content: "# relmx v2\n" }] },
];

interface RelmxFixture {
  ownerCookie: string;
  readCookie: string;
  repo: RepoRow;
}

/** The per-test fixture (re-run after every wipe — ensureSeededRepo skips the
 *  pack push once the engine refs exist and re-creates the D1 rows): the
 *  owner, a read-only collaborator, the content repo (main + refs/tags/v1),
 *  the never-pushed twin, and the `release`-family webhook subscriber whose
 *  delivery rows the write assertions read back. */
async function seedRelmxFixture(): Promise<RelmxFixture> {
  const owner = await seedVerifiedUser({ username: "relmx-owner" });
  const read = await seedVerifiedUser({ username: "relmx-read" });
  await ensureSeededRepo({
    owner: "relmx-owner",
    slug: "rel",
    commits: RELMX_COMMITS,
    tags: [{ name: "v1", commitIndex: 0 }],
  });
  const repoRow = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "relmx-owner"), eq(repositories.slug, "rel")))
    .get();
  if (repoRow === undefined) throw new Error("relmx repo row missing");
  if (repoRow.visibility !== "public" || repoRow.isEmpty) {
    // The re-created row (post-wipe) forgets the push-create stamps: the
    // engine refs persist, so pin visibility and the non-empty flag to the
    // real state — the family's MustBeNotEmpty gate reads is_empty.
    await drizzle(env.DB).update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, repoRow.id));
  }
  await addOrUpdateCollaborator(env.DB, repoRow.id, read.id, "read", at(1));
  const empty = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "relmx-owner" },
    name: "rel-empty",
    isPrivate: false,
    status: "ready",
  });
  if (empty.visibility !== "public") {
    await drizzle(env.DB).update(repositories).set({ visibility: "public" }).where(eq(repositories.id, empty.id));
  }
  await createRepoHook(env.DB, repoRow.id, {
    type: "gitea",
    name: "Relmx release relay",
    config: { url: "https://hooks.example.com/relmx", content_type: "json", secret: "relmx-secret" },
    active: true,
    branch_filter: "*",
    events: ["release"],
  });
  return {
    ownerCookie: await sessionHeader(owner.id),
    readCookie: await sessionHeader(read.id),
    repo: repoRow,
  };
}

let fixture: RelmxFixture | null = null;

async function theFixture(): Promise<RelmxFixture> {
  if (fixture === null) fixture = await seedRelmxFixture();
  return fixture;
}

/** Seed one release row through the LANDED create arm with a fixed `now`. */
async function seedRelease(input: {
  repoId: string;
  publisherId: number;
  tagName: string;
  title: string;
  note?: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
}): Promise<ReleaseRow> {
  return new IssuesService(env.DB).createRelease({
    repoId: input.repoId,
    publisherId: input.publisherId,
    tagName: input.tagName,
    target: "main",
    title: input.title,
    note: input.note ?? "",
    isDraft: input.isDraft ?? false,
    isPrerelease: input.isPrerelease ?? false,
    now: at(100),
  });
}

/** The owner's user id — looked up fresh (the per-test wipe invalidates ids). */
async function ownerId(): Promise<number> {
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "relmx-owner")).get();
  if (row === undefined) throw new Error("relmx owner row missing");
  return row.id;
}

/** The release webhook's delivery rows (event type + payload text). */
async function releaseDeliveries(): Promise<Array<{ eventType: string; payloadContent: string }>> {
  return drizzle(env.DB)
    .select({ eventType: webhookDeliveries.eventType, payloadContent: webhookDeliveries.payloadContent })
    .from(webhookDeliveries)
    .all();
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  fixture = null;
  // FK order: leaf rows first, repositories before users (sessions cascade
  // from users — the notifications wipe precedent). webhook_deliveries and
  // releases carry no outbound FKs (migration 0002's plain tables).
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "release_assets",
    "releases",
    "repo_collaborators",
    "repo_settings",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the claim pins ---------------------------------------------------------------

describe("releases family claim pins (parseUiRoute / handlesUiRoute)", () => {
  it("canonicalizes the trailing-slash form of every literal and wildcard shape", () => {
    expect(parseUiRoute("/octo/hello/releases/new/")).toEqual({ family: "release-new", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/releases/latest/")).toEqual({ family: "release-latest", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/releases/delete/")).toEqual({ family: "release-delete", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/releases/tag/v1/")).toEqual({
      family: "release-detail",
      owner: "octo",
      repo: "hello",
      tag: "v1",
    });
    // The edit wildcard keeps slashes through the trim too.
    expect(parseUiRoute("/octo/hello/releases/edit/rel/1.0/")).toEqual({
      family: "release-edit",
      owner: "octo",
      repo: "hello",
      tag: "rel/1.0",
    });
  });

  it("leaves malformed percent-encodings unclaimed (decodeURIComponent throws → engine 404)", () => {
    expect(parseUiRoute("/octo/hello/releases/tag/%zz")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/edit/%zz")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/attachments/%zz")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/download/%zz/x")).toBeNull();
    expect(handlesUiRoute("/octo/hello/releases/tag/%zz")).toBe(false);
  });

  it("keeps the deeper tails under the write literals engine-owned", () => {
    expect(parseUiRoute("/octo/hello/releases/delete/x")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/latest/x")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/new/x")).toBeNull();
    expect(handlesUiRoute("/octo/hello/releases/delete/x")).toBe(false);
  });
});

// --- the anon gate on the wave-33 POST tails ---------------------------------------

describe("the anon gate on the edit/delete POST arms (the missing 303s)", () => {
  it("303s an anonymous same-origin POST /releases/edit/{tag} onto the login round-trip, nothing written", async () => {
    const { repo, ownerCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Anon edit target" });

    const res = await postArm("/relmx-owner/rel/releases/edit/v1", null, { title: "Hijacked" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/relmx-owner/rel/releases/edit/v1")}`,
    );
    // D1 read-back: the title is untouched.
    const row = await findReleaseByTag(env.DB, repo.id, "v1");
    expect(row?.title).toBe("Anon edit target");
    // The owner's own session still reaches the form (the gate, not the route,
    // is what the anonymous arm exercises).
    expect((await fetchUi("/relmx-owner/rel/releases/edit/v1", { headers: { cookie: ownerCookie } })).status).toBe(200);
  });

  it("303s an anonymous same-origin POST /releases/delete onto the login round-trip, nothing deleted", async () => {
    const { repo } = await theFixture();
    const seeded = await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Survivor" });

    const res = await postArm("/relmx-owner/rel/releases/delete", null, { id: String(seeded.id) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/relmx-owner/rel/releases/delete")}`,
    );
    expect(await findReleaseByTag(env.DB, repo.id, "v1")).not.toBeNull();
    expect(await releaseDeliveries()).toEqual([]);
  });
});

// --- the write gates: non-writer + archived + empty ---------------------------------

describe("the write gates on the edit/delete tails (non-writer, archived, empty)", () => {
  it("404-shells the read collaborator on the edit GET and POST, the write never lands", async () => {
    const { repo, readCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Keep me" });

    expect((await fetchUi("/relmx-owner/rel/releases/edit/v1", { headers: { cookie: readCookie } })).status).toBe(404);
    const post = await postArm("/relmx-owner/rel/releases/edit/v1", readCookie, { title: "Escalated" });
    expect(post.status).toBe(404);
    expect((await findReleaseByTag(env.DB, repo.id, "v1"))?.title).toBe("Keep me");
  });

  it("404-shells the archived repo on the write tails while the list still renders", async () => {
    const { repo, ownerCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Archived target" });
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, repo.id));

    expect((await fetchUi("/relmx-owner/rel/releases/edit/v1", { headers: { cookie: ownerCookie } })).status).toBe(404);
    expect(
      (await postArm("/relmx-owner/rel/releases/new", ownerCookie, { tag_name: "a1", tag_target: "main", title: "A" }))
        .status,
    ).toBe(404);
    expect(
      (await postArm("/relmx-owner/rel/releases/delete", ownerCookie, { id: "1" })).status,
    ).toBe(404);
    // The rows: nothing written, nothing deleted.
    expect((await findReleaseByTag(env.DB, repo.id, "v1"))?.title).toBe("Archived target");
    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(1);
    // The read group survives the archive (upstream gates the read group on
    // MustBeNotEmpty only — the list still renders).
    expect((await fetchUi("/relmx-owner/rel/releases", { headers: { cookie: ownerCookie } })).status).toBe(200);
  });

  it("404-shells the empty repo on every write tail before any write", async () => {
    const { ownerCookie } = await theFixture();

    expect((await fetchUi("/relmx-owner/rel-empty/releases/edit/v1", { headers: { cookie: ownerCookie } })).status).toBe(404);
    expect(
      (await postArm("/relmx-owner/rel-empty/releases/new", ownerCookie, { tag_name: "e1", tag_target: "main", title: "E" }))
        .status,
    ).toBe(404);
    expect((await postArm("/relmx-owner/rel-empty/releases/delete", ownerCookie, { id: "1" })).status).toBe(404);
    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(0);
  });
});

// --- the §2.8 cross-origin 403s (guard-front on all three POST arms) ----------------

describe("the cross-origin 403s (sameOriginGuard fronts the new/edit/delete arms)", () => {
  it("rejects a cross-origin POST /releases/new before the session is read — cookie or not", async () => {
    await theFixture();
    const fields = { tag_name: "co-v1", tag_target: "main", title: "Cross-origin write" };

    const signed = await postArm("/relmx-owner/rel/releases/new", (await theFixture()).ownerCookie, fields, "https://evil.example");
    expect(signed.status).toBe(403);
    expect(signed.headers.get("content-type")).toContain("text/plain");
    expect(signed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await signed.text()).toContain("cross-origin request rejected");
    // Without any cookie the guard precedes the login 303 too (403, not 303).
    const anon = await postArm("/relmx-owner/rel/releases/new", null, fields, "https://evil.example");
    expect(anon.status).toBe(403);
    // Nothing was written either way.
    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(0);
    expect(await releaseDeliveries()).toEqual([]);
  });

  it("rejects a cross-origin POST /releases/edit/{tag} and the stored row keeps its bytes", async () => {
    const { repo, ownerCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Untouched" });

    const signed = await postArm("/relmx-owner/rel/releases/edit/v1", ownerCookie, { title: "Hacked" }, "https://evil.example");
    expect(signed.status).toBe(403);
    expect(await signed.text()).toContain("cross-origin request rejected");
    const anon = await postArm("/relmx-owner/rel/releases/edit/v1", null, { title: "Hacked" }, "https://evil.example");
    expect(anon.status).toBe(403);
    expect((await findReleaseByTag(env.DB, repo.id, "v1"))?.title).toBe("Untouched");
    expect(await releaseDeliveries()).toEqual([]);
  });

  it("rejects a cross-origin POST /releases/delete — including the Origin-less Referer fallback — and admits the same-origin referer", async () => {
    const { repo, ownerCookie } = await theFixture();
    const seeded = await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Doomed" });

    // Origin-header arms: valid cookie and cookie-less both 403 guard-first.
    const signed = await postArm("/relmx-owner/rel/releases/delete", ownerCookie, { id: String(seeded.id) }, "https://evil.example");
    expect(signed.status).toBe(403);
    expect(await findReleaseByTag(env.DB, repo.id, "v1")).not.toBeNull();
    const anon = await postArm("/relmx-owner/rel/releases/delete", null, { id: String(seeded.id) }, "https://evil.example");
    expect(anon.status).toBe(403);

    // The Referer fallback: no Origin header, a FOREIGN referer 403s…
    const foreignRef = await postArm(
      "/relmx-owner/rel/releases/delete",
      ownerCookie,
      { id: String(seeded.id) },
      null,
      "https://evil.example/trap",
    );
    expect(foreignRef.status).toBe(403);
    expect(await findReleaseByTag(env.DB, repo.id, "v1")).not.toBeNull();

    // …and the SAME-ORIGIN referer passes the guard: the write goes through.
    const ownRef = await postArm(
      "/relmx-owner/rel/releases/delete",
      ownerCookie,
      { id: String(seeded.id) },
      null,
      "https://test.local/relmx-owner/rel/releases/edit/v1",
    );
    expect(ownRef.status).toBe(303);
    expect(await findReleaseByTag(env.DB, repo.id, "v1")).toBeNull();
  });
});

// --- the create/edit round-trips over the draft/prerelease flags ---------------------

describe("the create round-trips (prerelease + draft flags)", () => {
  it("a prerelease-only publish is visible unauthenticated, labelled Pre-Release, and never Latest", async () => {
    const { repo } = await theFixture();

    const res = await postArm("/relmx-owner/rel/releases/new", (await theFixture()).ownerCookie, {
      tag_name: "rc1",
      tag_target: "main",
      title: "RC one",
      content: "Release candidate notes.",
      prerelease: "on",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/relmx-owner/rel/releases/tag/rc1");

    // The row: published (stamped), prerelease, not draft.
    const row = await findReleaseByTag(env.DB, repo.id, "rc1");
    expect(row?.isDraft).toBe(false);
    expect(row?.isPrerelease).toBe(true);
    expect((row?.publishedUnix ?? 0)).toBeGreaterThan(0);
    // The `release` webhook fired "published" for the non-draft.
    const delivery = (await releaseDeliveries())[0];
    expect(delivery?.eventType).toBe("release");
    expect(delivery?.payloadContent).toContain('"published"');
    expect(delivery?.payloadContent).toContain("rc1");

    // The anonymous list renders the entry with the orange Pre-Release label
    // (the label.tmpl if/else-if order — draft never wins here).
    const html = await (await fetchUi("/relmx-owner/rel/releases")).text();
    expect(html).toContain('href="/relmx-owner/rel/releases/tag/rc1"');
    expect(html).toContain('<span class="ui orange label">Pre-Release</span>');
    // The latest redirect refuses the prerelease (findLatestRelease's stable
    // contract) — it is the repo's only release.
    expect((await fetchUi("/relmx-owner/rel/releases/latest")).status).toBe(404);
  });

  it("a draft create 303s onto its detail page: the writer sees it, the anonymous viewer 404s, no webhook", async () => {
    const { repo, ownerCookie } = await theFixture();

    const res = await postArm("/relmx-owner/rel/releases/new", ownerCookie, {
      tag_name: "quiet",
      tag_target: "main",
      title: "Quiet draft",
      draft: "on",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/relmx-owner/rel/releases/tag/quiet");

    const row = await findReleaseByTag(env.DB, repo.id, "quiet");
    expect(row?.isDraft).toBe(true);
    expect(row?.publishedUnix).toBe(0);
    // The visibility pair at route level: anon 404-shells, writer renders.
    expect((await fetchUi("/relmx-owner/rel/releases/tag/quiet")).status).toBe(404);
    expect(
      (await fetchUi("/relmx-owner/rel/releases/tag/quiet", { headers: { cookie: ownerCookie } })).status,
    ).toBe(200);
    // Drafts stay silent — the webhook subscriber saw nothing.
    expect(await releaseDeliveries()).toEqual([]);
  });

  it("re-renders the create form on the server-side length guards and writes nothing", async () => {
    const { ownerCookie } = await theFixture();

    const longTag = await postArm("/relmx-owner/rel/releases/new", ownerCookie, {
      tag_name: "x".repeat(256),
      tag_target: "main",
      title: "T",
    });
    expect(longTag.status).toBe(200);
    expect(await longTag.text()).toContain("Tag name must be at most 255 characters.");

    const longTitle = await postArm("/relmx-owner/rel/releases/new", ownerCookie, {
      tag_name: "ok-tag",
      tag_target: "main",
      title: "T".repeat(256),
    });
    expect(longTitle.status).toBe(200);
    expect(await longTitle.text()).toContain("Release title must be at most 255 characters.");

    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(0);
  });
});

describe("the edit arm's flag round-trips (the webhook action mapping)", () => {
  it("publishing a draft through the edit flip stamps published_unix and emits action published", async () => {
    const { repo, ownerCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Draft v1", isDraft: true });
    expect((await fetchUi("/relmx-owner/rel/releases/tag/v1")).status).toBe(404);

    // The draft checkbox OFF: upstream EditReleasePost's `len(form.Draft) > 0`.
    const res = await postArm(
      "/relmx-owner/rel/releases/edit/v1",
      ownerCookie,
      { title: "Published v1", content: "Now public." },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/relmx-owner/rel/releases");

    const row = await findReleaseByTag(env.DB, repo.id, "v1");
    expect(row?.isDraft).toBe(false);
    expect((row?.publishedUnix ?? 0)).toBeGreaterThan(0); // the UpdateRelease stamp
    // The draft→published flip maps to action "published" (release.go:363-366).
    const delivery = (await releaseDeliveries())[0];
    expect(delivery?.eventType).toBe("release");
    expect(delivery?.payloadContent).toContain('"published"');
    expect(delivery?.payloadContent).toContain("v1");
    // The round-trip closes: the anonymous viewer sees the release now.
    expect((await fetchUi("/relmx-owner/rel/releases/tag/v1")).status).toBe(200);
  });

  it("re-drafting a published release through the edit flip is webhook-silent and hides it again", async () => {
    const { repo, ownerCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Going quiet" });

    const res = await postArm(
      "/relmx-owner/rel/releases/edit/v1",
      ownerCookie,
      { title: "Going quiet", content: "Back to draft.", draft: "on" },
    );
    expect(res.status).toBe(303);

    const row = await findReleaseByTag(env.DB, repo.id, "v1");
    expect(row?.isDraft).toBe(true);
    // The emit gate (`!updated.isDraft`) kept the subscriber silent.
    expect(await releaseDeliveries()).toEqual([]);
    // The anonymous list/detail hide the re-drafted release; the writer's list
    // still carries the yellow Draft label.
    const anonHtml = await (await fetchUi("/relmx-owner/rel/releases")).text();
    expect(anonHtml).not.toContain("Going quiet");
    expect((await fetchUi("/relmx-owner/rel/releases/tag/v1")).status).toBe(404);
    const writerHtml = await (
      await fetchUi("/relmx-owner/rel/releases", { headers: { cookie: ownerCookie } })
    ).text();
    expect(writerHtml).toContain('<span class="ui yellow label">Draft</span>');
  });

  it("a plain published→published edit emits action updated with the new title", async () => {
    const { repo, ownerCookie } = await theFixture();
    await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Before" });

    const res = await postArm("/relmx-owner/rel/releases/edit/v1", ownerCookie, {
      title: "After",
      content: "Renamed in place.",
    });
    expect(res.status).toBe(303);

    expect((await findReleaseByTag(env.DB, repo.id, "v1"))?.title).toBe("After");
    const delivery = (await releaseDeliveries())[0];
    expect(delivery?.eventType).toBe("release");
    expect(delivery?.payloadContent).toContain('"updated"');
    expect(delivery?.payloadContent).toContain("After");
  });
});

// --- the delete arms at the webhook level ---------------------------------------------

describe("the delete arms (cascade + webhook scope + junk carriers)", () => {
  it("deleting a published release cascades its asset rows and emits action deleted", async () => {
    const { repo, ownerCookie } = await theFixture();
    const seeded = await seedRelease({
      repoId: repo.id,
      publisherId: await ownerId(),
      tagName: "v1",
      title: "Rel v1",
      note: "Doomed notes.",
    });
    await drizzle(env.DB).insert(releaseAssets).values({
      uuid: "relmx-asset-doomed",
      repoId: repo.id,
      releaseId: seeded.id,
      uploaderId: await ownerId(),
      name: "doomed.zip",
      size: 10,
      downloadCount: 0,
      r2Key: `repos/relmx/release-assets/${seeded.id}/relmx-asset-doomed-doomed.zip`,
      checksumSha256: null,
      createdAt: at(105),
    });

    const res = await postArm("/relmx-owner/rel/releases/delete", ownerCookie, { id: String(seeded.id) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/relmx-owner/rel/releases?deleted=${encodeURIComponent("Rel v1")}`,
    );
    // The batch cascade: the release row AND its asset rows are gone.
    expect(await findReleaseByTag(env.DB, repo.id, "v1")).toBeNull();
    expect(
      (await drizzle(env.DB).select({ id: releaseAssets.id }).from(releaseAssets).where(eq(releaseAssets.releaseId, seeded.id)).all())
        .length,
    ).toBe(0);
    // The `release` "deleted" webhook (drafts-only silence does not apply).
    const delivery = (await releaseDeliveries())[0];
    expect(delivery?.eventType).toBe("release");
    expect(delivery?.payloadContent).toContain('"deleted"');
    expect(delivery?.payloadContent).toContain("v1");
  });

  it("deleting a draft release is webhook-silent", async () => {
    const { repo, ownerCookie } = await theFixture();
    const seeded = await seedRelease({
      repoId: repo.id,
      publisherId: await ownerId(),
      tagName: "hush",
      title: "Hushed draft",
      isDraft: true,
    });

    const res = await postArm("/relmx-owner/rel/releases/delete", ownerCookie, { id: String(seeded.id) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/relmx-owner/rel/releases?deleted=${encodeURIComponent("Hushed draft")}`,
    );
    expect(await findReleaseByTag(env.DB, repo.id, "hush")).toBeNull();
    expect(await releaseDeliveries()).toEqual([]);
  });

  it("404-shells the junk id carriers before any write", async () => {
    const { repo, ownerCookie } = await theFixture();
    const seeded = await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Stays" });

    // parseReleaseDeleteForm's non-digit / zero arms and the absent field.
    expect((await postArm("/relmx-owner/rel/releases/delete", ownerCookie, { id: "abc" })).status).toBe(404);
    expect((await postArm("/relmx-owner/rel/releases/delete", ownerCookie, { id: "0" })).status).toBe(404);
    expect((await postArm("/relmx-owner/rel/releases/delete", ownerCookie, null)).status).toBe(404);
    expect((await findReleaseByTag(env.DB, repo.id, "v1"))?.id).toBe(seeded.id);
    expect(await releaseDeliveries()).toEqual([]);
  });
});

// --- the flash + attachment arms ------------------------------------------------------

describe("the query-param flash and the attachment route gates", () => {
  it("renders the delete_failed negative flash from the query params", async () => {
    await theFixture();
    const res = await fetchUi("/relmx-owner/rel/releases?delete_error=failed&name=v1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">Deleting the release v1 failed.</div>');
  });

  it("the disabled releases unit 404-shells BOTH download tails over an otherwise-servable asset", async () => {
    const { repo, ownerCookie } = await theFixture();
    const seeded = await seedRelease({ repoId: repo.id, publisherId: await ownerId(), tagName: "v1", title: "Asset host" });
    const bytes = new TextEncoder().encode("relmx asset body\n");
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
    const attachmentPath = `/relmx-owner/rel/releases/attachments/${asset.uuid}`;
    const downloadPath = "/relmx-owner/rel/releases/download/v1/notes.txt";

    // Baseline: both tails serve over the real R2 object.
    const served = await fetchUi(attachmentPath, { headers: { cookie: ownerCookie } });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("relmx asset body\n");
    expect((await fetchUi(downloadPath)).status).toBe(200);

    // The unit gate (releasesReadGate's hasReleases arm) shells both.
    await saveRepoSettings(env.DB, repo.id, { hasReleases: false }, at(110));
    expect((await fetchUi(attachmentPath)).status).toBe(404);
    expect((await fetchUi(downloadPath)).status).toBe(404);

    // Restoring the unit restores the serves (the gate, not the rows, was
    // refusing).
    await saveRepoSettings(env.DB, repo.id, { hasReleases: true }, at(111));
    expect((await fetchUi(attachmentPath)).status).toBe(200);
    expect((await fetchUi(downloadPath)).status).toBe(200);
  });
});
