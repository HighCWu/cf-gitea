/**
 * Pages wave 33 route tests — the tags write + aux tails (the survey's
 * top-5 #2: `POST /{owner}/{repo}/tags/delete` + the per-row Delete Tag
 * control + `GET /{owner}/{repo}/tags/list`, pages/tag-list-aux.ts +
 * pages/tags.tsx's applyTagDelete) and the releases edit/delete tail (the
 * survey's top-5 #4: `GET|POST /{owner}/{repo}/releases/edit/{tag}` +
 * `POST /{owner}/{repo}/releases/delete` + the list pencil, pages/
 * releases.tsx).
 *
 * Upstream contracts under test (the module docs carry the cites):
 * tags/list — web.go:1499 repo.GetTagList: the branchTagSearchResponse byte
 * shape {"results":[names]}, no filter, no query, the JSON content type +
 * middleware Cache-Control, the MustBeNotEmpty 404 arm, byte-order names.
 * tags/delete — web.go:1501 DeleteTag → deleteReleaseOrTag(isDelTag=true):
 * the dual carriers (the D1-record `id`, the rowless-tag `tag` name arm —
 * our engine-universe extension), the release-attached 409 plain text, the
 * protected-tag flash refusal, the engine ref CAS + record drop, the
 * 303-with-flash-params convention, the gate ladder (anonymous → login 303,
 * archived/empty/non-writer → the 404 shell, GET → 405).
 * releases edit — web.go:1519-1520 EditRelease/EditReleasePost: new.tmpl
 * under PageIsEditRelease (hidden tag pair, Update Release heading, the
 * Cancel + Delete Release + Update submit row), the 404 arms (missing row,
 * tag-only record), the unconditional Title/Note set, the 303 onto the list,
 * the re-render on the empty title.
 * releases delete — web.go:1523 DeleteRelease: the form `id` carrier, the
 * 404 arm, the 303 + ?deleted= flash, the list pencil's CanCreateRelease
 * gate (absent for anonymous and on the detail page).
 *
 * Same harness posture as pages-wave25/32: identities riding minted session
 * cookies, POSTs carrying the same-origin Origin header; engine content
 * seeds through the REAL receive flow with fixed timestamps. Fixture repo
 * `wave33-owner/tagged` (main at c1; tags v1@c0 release-backed, rel/1.0@c1
 * protected then deleted, v2@c1 carrying a D1 tag-only record) and the
 * never-pushed `wave33-owner/tagged-empty` (the MustBeNotEmpty arms).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { findReleaseByTag } from "../../api/services/releases";
import { IssuesService } from "../../issues/service";
import { protectedTags, releases, repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (path: string, cookie: string): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

const formPost = (path: string, body: Record<string, string>, cookie: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://test.local",
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
  },
  body: new URLSearchParams(body).toString(),
});

// --- fixtures -----------------------------------------------------------------

const WAVE33_COMMITS: SeedCommit[] = [
  { message: "wave33: root", time: T0, files: [{ path: "README.md", content: "# wave33\n" }] },
  { message: "wave33: second", time: T0 + 60, files: [{ path: "README.md", content: "# wave33 v2\n" }] },
];

interface Wave33Fixture {
  ownerCookie: string;
  readCookie: string;
  repoId: string;
  v1ReleaseId: number;
  v2TagRecordId: number;
}

let wave33Fixture: Wave33Fixture | null = null;

async function ensureWave33Fixture(): Promise<Wave33Fixture> {
  if (wave33Fixture !== null) return wave33Fixture;
  await applyAuthD1Migrations();

  const db = drizzle(env.DB);
  const owner = (await db.select().from(users).where(eq(users.usernameLower, "wave33-owner")).get()) ?? (await seedVerifiedUser({ username: "wave33-owner" }));
  const read = (await db.select().from(users).where(eq(users.usernameLower, "wave33-read")).get()) ?? (await seedVerifiedUser({ username: "wave33-read" }));
  const now = new Date(1_700_000_000 * 1000);

  // The engine-content repo: main at c1; tags v1@c0, rel/1.0@c1, v2@c1 and
  // the protected-refusal arm keep/me@c1 through the REAL receive flow.
  await ensureSeededRepo({
    owner: "wave33-owner",
    slug: "tagged",
    commits: WAVE33_COMMITS,
    tags: [
      { name: "v1", commitIndex: 0 },
      { name: "rel/1.0", commitIndex: 1 },
      { name: "v2", commitIndex: 1 },
      { name: "keep/me", commitIndex: 1 },
    ],
  });
  const repoRow = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "wave33-owner"), eq(repositories.slug, "tagged")))
    .get();
  if (repoRow === undefined) throw new Error("wave33 tagged row missing");
  await addOrUpdateCollaborator(env.DB, repoRow.id, read.id, "read", now);

  // The release-backed v1 (the pencil + the 409 arm) and the tag-only D1
  // record on v2 (the `?id=` carrier arm) — idempotent creates.
  const service = new IssuesService(env.DB);
  let v1Row = await findReleaseByTag(env.DB, repoRow.id, "v1");
  if (v1Row === null || v1Row.isTag) {
    v1Row = await service.createRelease({
      repoId: repoRow.id,
      publisherId: owner.id,
      tagName: "v1",
      target: "main",
      title: "Wave 33 release",
      note: "hello notes",
      isDraft: false,
      isPrerelease: false,
      now,
    });
  }
  let v2Record = await findReleaseByTag(env.DB, repoRow.id, "v2");
  if (v2Record === null) {
    const inserted = await drizzle(env.DB)
      .insert(releases)
      .values({
        repoId: repoRow.id,
        publisherId: owner.id,
        tagName: "v2",
        lowerTagName: "v2",
        isTag: true,
        createdAt: now,
      })
      .returning();
    const created = inserted[0];
    if (created === undefined) throw new Error("wave33 v2 tag record insert lost");
    v2Record = created;
  }
  if (!v2Record.isTag) throw new Error("wave33 v2 tag record missing");

  // The protected-tag rule matching keep/* (the flash refusal arm — the
  // empty allowlist refuses every controller, upstream's own semantics) —
  // inserted only when absent so re-runs keep the single rule.
  const existingRule = await drizzle(env.DB)
    .select()
    .from(protectedTags)
    .where(and(eq(protectedTags.repoId, repoRow.id), eq(protectedTags.namePattern, "keep/*")))
    .get();
  if (existingRule === undefined) {
    await drizzle(env.DB).insert(protectedTags).values({
      repoId: repoRow.id,
      namePattern: "keep/*",
      allowlistUserIds: "[]",
      allowlistTeamIds: "[]",
      createdAt: now,
      updatedAt: now,
    });
  }

  // The never-pushed repo (the MustBeNotEmpty arms).
  const emptyExisting = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "wave33-owner"), eq(repositories.slug, "tagged-empty")))
    .get();
  if (emptyExisting === undefined) {
    await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: "wave33-owner" },
      name: "tagged-empty",
      isPrivate: false,
      status: "ready",
    });
  }

  wave33Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    readCookie: await mintSession(env.DB, read.id),
    repoId: repoRow.id,
    v1ReleaseId: v1Row.id,
    v2TagRecordId: v2Record.id,
  };
  return wave33Fixture;
}

let fixture: Wave33Fixture | null = null;

async function theFixture(): Promise<Wave33Fixture> {
  if (fixture === null) fixture = await ensureWave33Fixture();
  return fixture;
}

beforeAll(async () => {
  await theFixture();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-33 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the tags aux and delete tails and nothing deeper", () => {
    expect(parseUiRoute("/octo/hello/tags/list")).toEqual({ family: "tags-list-aux", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/tags/delete")).toEqual({ family: "tags-delete", owner: "octo", repo: "hello" });
    // The bare literal is untouched (wave-25's claim); a foreign tail stays
    // engine-owned (upstream's unregistered-route answer).
    expect(parseUiRoute("/octo/hello/tags")).toEqual({ family: "tags", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/tags/feed")).toBeNull();
    expect(parseUiRoute("/octo/hello/tags/list/extra")).toBeNull();
    expect(handlesUiRoute("/octo/hello/tags/list")).toBe(true);
    expect(handlesUiRoute("/octo/hello/tags/feed")).toBe(false);
  });

  it("claims the releases edit wildcard and delete literal inside the releases space", () => {
    expect(parseUiRoute("/octo/hello/releases/edit/v1.0")).toEqual({
      family: "release-edit",
      owner: "octo",
      repo: "hello",
      tag: "v1.0",
    });
    // The wildcard tail keeps slashes (chi's `*` param — refnames do).
    expect(parseUiRoute("/octo/hello/releases/edit/rel/1.0")).toEqual({
      family: "release-edit",
      owner: "octo",
      repo: "hello",
      tag: "rel/1.0",
    });
    expect(parseUiRoute("/octo/hello/releases/delete")).toEqual({
      family: "release-delete",
      owner: "octo",
      repo: "hello",
    });
    // The bare edit literal is upstream's unregistered shape → engine-owned;
    // the landed families are untouched.
    expect(parseUiRoute("/octo/hello/releases/edit")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/tag/v1.0")?.family).toBe("release-detail");
    expect(parseUiRoute("/octo/hello/releases")?.family).toBe("releases");
    expect(handlesUiRoute("/octo/hello/releases/edit/rel/1.0")).toBe(true);
    expect(handlesUiRoute("/octo/hello/releases/edit")).toBe(false);
  });
});

// --- the tags aux JSON -----------------------------------------------------------

describe("GET /{owner}/{repo}/tags/list", () => {
  it("serves the branchTagSearchResponse byte shape over the byte-order names", async () => {
    const res = await fetchUi("/wave33-owner/tagged/tags/list");
    expect(res.status).toBe(200);
    // ctx.JSON's content type + the middleware's zero-option prod stamp (the
    // wave-32 containedRefsResponse sibling).
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    // No filter, no query: every tag name, byte-order sorted ("keep/me" <
    // "rel/1.0" < "v1" < "v2" — the landed sortedTags convention; upstream's
    // git tag order divergence is the module header's note). ?q= is IGNORED
    // like upstream's handler.
    expect(await res.text()).toBe('{"results":["keep/me","rel/1.0","v1","v2"]}');
    const filtered = await fetchUi("/wave33-owner/tagged/tags/list?q=v1&page=2");
    expect(await filtered.text()).toBe('{"results":["keep/me","rel/1.0","v1","v2"]}');
  });

  it("404s the empty repo (MustBeNotEmpty) and the deeper tails", async () => {
    expect((await fetchUi("/wave33-owner/tagged-empty/tags/list")).status).toBe(404);
    // The unclaimed shape reaches neither family (the drift guard's shell
    // when driven directly — upstream's pattern miss is engine-owned).
    expect((await fetchUi("/wave33-owner/tagged/tags/list/extra")).status).toBe(404);
  });
});

// --- the tags page delete control ------------------------------------------------

describe("the tags page delete control (wave-33 hunks)", () => {
  it("renders the writer-gated form with the right carrier per row", async () => {
    const { ownerCookie, readCookie, v2TagRecordId } = await theFixture();
    const ownerHtml = await (await fetchUi("/wave33-owner/tagged/tags", withCookie("/wave33-owner/tagged/tags", ownerCookie))).text();
    // The D1-record tag carries upstream's `id` carrier...
    expect(ownerHtml).toContain('action="/wave33-owner/tagged/tags/delete"');
    expect(ownerHtml).toContain(`name="id" value="${v2TagRecordId}"`);
    // ...the rowless engine tag the name-keyed arm...
    expect(ownerHtml).toContain('name="tag" value="rel/1.0"');
    // ...and the release-backed tag carries NO delete control (upstream's
    // `$release.IsTag` gate) — its Detail link stands instead.
    expect(ownerHtml).not.toContain('name="tag" value="v1"');
    expect(ownerHtml).toContain('href="/wave33-owner/tagged/releases/tag/v1"');
    // The anonymous page renders NO control (the writer gate).
    const anonHtml = await (await fetchUi("/wave33-owner/tagged/tags")).text();
    expect(anonHtml).not.toContain("/tags/delete");
    // The read collaborator (a repo reader, not a writer) neither.
    const readHtml = await (await fetchUi("/wave33-owner/tagged/tags", withCookie("/x", readCookie))).text();
    expect(readHtml).not.toContain("/tags/delete");
  });

  it("renders the per-row ZIP / TAR.GZ archive pair for every reader (tag/list.tmpl:36-39)", async () => {
    // The pair is reader-facing (no write gate — only the not-modeled
    // DisableDownloadSourceArchives setting, default-on): the anonymous page
    // carries it on EVERY row, release-backed or tag-only, onto the LANDED
    // web-shape archive route (wave-32; the ref resolves branch → tag →
    // oid). Slash tag names keep their slashes (the route re-parses
    // multi-segment tails); the old "the archive links are unrendered"
    // reduction carried the stale missing-route premise.
    const anonHtml = await (await fetchUi("/wave33-owner/tagged/tags")).text();
    expect(anonHtml).toContain('class="archive-link flex-text-inline" href="/wave33-owner/tagged/archive/v1.zip"');
    expect(anonHtml).toContain('href="/wave33-owner/tagged/archive/v1.tar.gz"');
    expect(anonHtml).toContain('href="/wave33-owner/tagged/archive/rel/1.0.zip"');
    expect(anonHtml).toContain('href="/wave33-owner/tagged/archive/rel/1.0.tar.gz"');
    expect(anonHtml).toContain('href="/wave33-owner/tagged/archive/v2.zip"');
    expect(anonHtml).toContain('href="/wave33-owner/tagged/archive/keep/me.tar.gz"');
    // The links WORK: one of them serves the archive bytes end-to-end
    // (the dead-link rule — the mount is not decorative).
    const zip = await fetchUi("/wave33-owner/tagged/archive/v2.zip");
    expect(zip.status).toBe(200);
  });
});

// --- the tag delete write --------------------------------------------------------

describe("POST /{owner}/{repo}/tags/delete", () => {
  it("refuses a protected tag with the flash and keeps the ref", async () => {
    const { ownerCookie } = await theFixture();
    const res = await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { tag: "keep/me" }, ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave33-owner/tagged/tags?delete_error=protected&name=keep%2Fme");
    // The flash text renders on the list page; the ref survives.
    const html = await (await fetchUi("/wave33-owner/tagged/tags?delete_error=protected", withCookie("/x", ownerCookie))).text();
    expect(html).toContain("The tag name is protected.");
    const refs = await env.REPO.getByName("wave33-owner/tagged").listRefs();
    expect((refs.refs ?? []).some((ref) => ref.name === "refs/tags/keep/me")).toBe(true);
  });

  it("answers the 409 class for a tag attached to a release (the id arm)", async () => {
    const { ownerCookie, v1ReleaseId } = await theFixture();
    const res = await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { id: String(v1ReleaseId) }, ownerCookie));
    // ctx.HTTPError(409)'s plain text (base.go:105-113) + the nosniff stamp.
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("a tag attached to a release cannot be deleted directly\n");
    // The name arm reaches the same refusal through the row's isTag flag.
    const byName = await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { tag: "v1" }, ownerCookie));
    expect(byName.status).toBe(409);
  });

  it("deletes the rowless engine tag through the name arm (303 + flash + ref gone)", async () => {
    const { ownerCookie } = await theFixture();
    const res = await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { tag: "rel/1.0" }, ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave33-owner/tagged/tags?deleted=rel%2F1.0");
    const refs = await env.REPO.getByName("wave33-owner/tagged").listRefs();
    expect((refs.refs ?? []).some((ref) => ref.name === "refs/tags/rel/1.0")).toBe(false);
    const html = await (await fetchUi("/wave33-owner/tagged/tags?deleted=rel/1.0", withCookie("/x", ownerCookie))).text();
    expect(html).toContain("The tag has been deleted.");
    expect(html).not.toContain("rel/1.0</a>");
  });

  it("deletes the D1 record + the git ref through the id arm", async () => {
    const { ownerCookie, v2TagRecordId } = await theFixture();
    const res = await fetchUi(
      "/wave33-owner/tagged/tags/delete",
      formPost("/x", { id: String(v2TagRecordId) }, ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave33-owner/tagged/tags?deleted=v2");
    const refs = await env.REPO.getByName("wave33-owner/tagged").listRefs();
    expect((refs.refs ?? []).some((ref) => ref.name === "refs/tags/v2")).toBe(false);
    expect(await findReleaseByTag(env.DB, (await theFixture()).repoId, "v2")).toBeNull();
  });

  it("404-shells a missing id/tag and answers the gate ladder", async () => {
    const { ownerCookie, readCookie } = await theFixture();
    // A missing record id — upstream GetReleaseForRepoByID's NotFound arm.
    expect(
      (await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { id: "999999" }, ownerCookie))).status,
    ).toBe(404);
    // A name the engine never had.
    expect((await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { tag: "nope" }, ownerCookie))).status).toBe(404);
    // An empty body — neither carrier.
    expect((await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", {}, ownerCookie))).status).toBe(404);
    // Anonymous → the login round-trip (reqSignIn precedes the group).
    const anon = await fetchUi("/wave33-owner/tagged/tags/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
      body: "tag=v1",
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Fwave33-owner%2Ftagged%2Ftags%2Fdelete");
    // A signed-in non-writer → the undiscoverable 404 shell (reqRepoCodeWriter).
    expect(
      (await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { tag: "v1" }, readCookie))).status,
    ).toBe(404);
    // The archived shell + the empty-repo shell (the group's gates).
    expect((await fetchUi("/wave33-owner/tagged-empty/tags/delete", formPost("/x", { tag: "v1" }, ownerCookie))).status).toBe(404);
    // GET answers chi's 405 (the hook test/delete convention).
    expect((await fetchUi("/wave33-owner/tagged/tags/delete")).status).toBe(405);
  });

  it("completes the delete cascade when the git tag is already gone — a record without a ref drops through the id arm (release.go:385-393's `tag -d` not-found tolerance)", async () => {
    const { repoId, ownerCookie } = await theFixture();
    // A D1 tag-only record whose git ref was never pushed (the row-only
    // half of the id carrier): the `tag -d` miss is upstream's tolerated
    // "not found" (release.go:389) and the record drop continues
    // (release.go:411-414).
    const owner = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "wave33-owner")).get();
    if (owner === undefined) throw new Error("wave33 owner missing");
    const inserted = await drizzle(env.DB)
      .insert(releases)
      .values({
        repoId,
        publisherId: owner.id,
        tagName: "late-record",
        lowerTagName: "late-record",
        isTag: true,
        createdAt: new Date(1_700_000_000 * 1000),
      })
      .returning({ id: releases.id });
    const recordId = inserted[0]!.id;

    const res = await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { id: String(recordId) }, ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave33-owner/tagged/tags?deleted=late-record");
    // The cascade's tail: the record is gone; nothing else moved.
    expect(await findReleaseByTag(env.DB, repoId, "late-record")).toBeNull();
    const refs = await env.REPO.getByName("wave33-owner/tagged").listRefs();
    expect((refs.refs ?? []).some((ref) => ref.name === "refs/tags/late-record")).toBe(false);
  });
});

// --- the releases edit page + write ----------------------------------------------

describe("GET /{owner}/{repo}/releases/edit/{tag}", () => {
  it("renders new.tmpl's PageIsEditRelease arm with the stored prefill", async () => {
    const { ownerCookie, v1ReleaseId } = await theFixture();
    const res = await fetchUi("/wave33-owner/tagged/releases/edit/v1", withCookie("/x", ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // The §2.4.1 discriminator + the heading swap.
    expect(html).toContain("repository new release");
    expect(html).toContain("Update Release");
    expect(html).toContain("Releases organize project versions.");
    // The tag pair goes hidden + the `tag @ target` text (new.tmpl:25-28).
    expect(html).toContain('action="/wave33-owner/tagged/releases/edit/v1"');
    expect(html).toContain('name="tag_name" value="v1"');
    expect(html).toContain('name="tag_target" value="main"');
    expect(html).toContain("v1 @ main");
    // The stored values prefill title/notes; the draft checkbox is off.
    expect(html).toContain('value="Wave 33 release"');
    expect(html).toContain("hello notes");
    // The submit row: Cancel, the red Delete (the formaction override riding
    // the row's id carrier), Update.
    expect(html).toContain('href="/wave33-owner/tagged/releases"');
    expect(html).toContain('formaction="/wave33-owner/tagged/releases/delete"');
    expect(html).toContain(`name="id" value="${v1ReleaseId}"`);
    expect(html).toContain("Delete Release");
  });

  it("404s the missing row, the pure-tag record and the empty repo; gates anonymous", async () => {
    const { ownerCookie } = await theFixture();
    // A tag the engine has but no release row backs (v1 is taken; rel/1.0
    // carries no record) — GetRelease's NotFound arm.
    expect((await fetchUi("/wave33-owner/tagged/releases/edit/nope", withCookie("/x", ownerCookie))).status).toBe(404);
    // The empty repo 404s through the write group's read gate.
    expect((await fetchUi("/wave33-owner/tagged-empty/releases/edit/v1", withCookie("/x", ownerCookie))).status).toBe(404);
    // Anonymous → the login round-trip (reqSignIn precedes the group).
    const anon = await fetchUi("/wave33-owner/tagged/releases/edit/v1");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Fwave33-owner%2Ftagged%2Freleases%2Fedit%2Fv1");
  });
});

describe("POST /{owner}/{repo}/releases/edit/{tag}", () => {
  it("applies the edit unconditionally and 303s onto the list", async () => {
    const { ownerCookie, repoId } = await theFixture();
    const res = await fetchUi(
      "/wave33-owner/tagged/releases/edit/v1",
      formPost("/x", { title: "Renamed release", content: "fresh notes", prerelease: "on" }, ownerCookie),
    );
    expect(res.status).toBe(303);
    // Upstream JSONRedirect's exact target: the list.
    expect(res.headers.get("location")).toBe("/wave33-owner/tagged/releases");
    const row = await findReleaseByTag(env.DB, repoId, "v1");
    expect(row?.title).toBe("Renamed release");
    expect(row?.note).toBe("fresh notes");
    expect(row?.isPrerelease).toBe(true);
    expect(row?.isDraft).toBe(false);
  });

  it("re-renders at 200 with the kept submission on the empty title", async () => {
    const { ownerCookie } = await theFixture();
    const res = await fetchUi(
      "/wave33-owner/tagged/releases/edit/v1",
      formPost("/x", { title: "   ", content: "kept notes" }, ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Title cannot be empty.");
    expect(html).toContain("kept notes");
  });
});

// --- the release delete write + the list pencil ----------------------------------

describe("POST /{owner}/{repo}/releases/delete + the list pencil", () => {
  it("renders the pencil for writers on the list only", async () => {
    const { ownerCookie, readCookie } = await theFixture();
    const ownerHtml = await (
      await fetchUi("/wave33-owner/tagged/releases", withCookie("/x", ownerCookie))
    ).text();
    expect(ownerHtml).toContain('href="/wave33-owner/tagged/releases/edit/v1"');
    // The anonymous list and the DETAIL page render no pencil (upstream's
    // `(not $.PageIsSingleTag)` arm).
    const anonHtml = await (await fetchUi("/wave33-owner/tagged/releases")).text();
    expect(anonHtml).not.toContain("/releases/edit/");
    const detailHtml = await (await fetchUi("/wave33-owner/tagged/releases/tag/v1", withCookie("/x", ownerCookie))).text();
    expect(detailHtml).not.toContain("/releases/edit/");
    // The read collaborator (not a release writer) neither.
    const readHtml = await (await fetchUi("/wave33-owner/tagged/releases", withCookie("/x", readCookie))).text();
    expect(readHtml).not.toContain("/releases/edit/");
  });

  it("deletes the release by the form id and flashes onto the list", async () => {
    const { ownerCookie, readCookie, v1ReleaseId, repoId } = await theFixture();
    // The non-writer 404s before the write (reqRepoReleaseWriter).
    expect((await fetchUi("/wave33-owner/tagged/releases/delete", formPost("/x", { id: "1" }, readCookie))).status).toBe(404);
    // A missing id — upstream GetReleaseForRepoByID's NotFound arm.
    expect(
      (await fetchUi("/wave33-owner/tagged/releases/delete", formPost("/x", { id: "999999" }, ownerCookie))).status,
    ).toBe(404);
    // GET answers chi's 405.
    expect((await fetchUi("/wave33-owner/tagged/releases/delete")).status).toBe(405);
    // The write.
    const res = await fetchUi(
      "/wave33-owner/tagged/releases/delete",
      formPost("/x", { id: String(v1ReleaseId) }, ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/wave33-owner/tagged/releases?deleted=${encodeURIComponent("Renamed release")}`,
    );
    expect(await findReleaseByTag(env.DB, repoId, "v1")).toBeNull();
    // The flash text renders on the list page (deletion_success).
    const html = await (
      await fetchUi("/wave33-owner/tagged/releases?deleted=R", withCookie("/x", ownerCookie))
    ).text();
    expect(html).toContain("The release has been deleted.");
    expect(html).not.toContain('href="/wave33-owner/tagged/releases/edit/v1"');
  });

  it("the release delete does NOT cascade the git tag — the freed tag then deletes through the name arm (release.go:416-423's IsTag flip keeps the ref)", async () => {
    const { ownerCookie } = await theFixture();
    // Upstream's release-delete arm flips the row's IsTag and never touches
    // the ref (release.go:416-423): the git tag v1 survives the release
    // deletion above.
    const before = await env.REPO.getByName("wave33-owner/tagged").listRefs();
    expect((before.refs ?? []).some((ref) => ref.name === "refs/tags/v1")).toBe(true);
    // The freed tag is now a plain rowless engine tag — the name arm's
    // delete applies (no protected rule matches v1; the keep/* rule's
    // anchored glob misses it).
    const res = await fetchUi("/wave33-owner/tagged/tags/delete", formPost("/x", { tag: "v1" }, ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave33-owner/tagged/tags?deleted=v1");
    const refs = await env.REPO.getByName("wave33-owner/tagged").listRefs();
    expect((refs.refs ?? []).some((ref) => ref.name === "refs/tags/v1")).toBe(false);
  });
});
