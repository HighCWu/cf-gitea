/**
 * Tier-1 release routes on real D1 (SPEC-0004 §2.4 rows repoListReleases /
 * repoCreateRelease / repoGetLatestRelease / repoGetReleaseByTag /
 * repoDeleteReleaseByTag / repoGetRelease / repoEditRelease /
 * repoDeleteRelease; upstream routers/api/v1/repo/release.go over the landed
 * `releases` table — writes ride the SPEC-0005 IssuesService.createRelease).
 * Pins: the 201 create + URL shapes (url/html_url/tarball/zipball/upload),
 * the 409 duplicate + tag-record conversion, the empty-repo 422, the
 * draft-visibility rule (404 without write access, incl. the list filters),
 * the `created_unix DESC, id DESC` ordering, the latest-release contract
 * (no drafts/prereleases/tag-only rows), the case-insensitive tag lookup,
 * the PATCH set-fields rule + publish stamp, the DELETE cascades (assets
 * included), the writer gate (403), the pin's NO-mustNotBeArchived
 * registration (a release write on an archived repo still answers 200-family,
 * unlike the topics family), and the `release` webhook emissions (published/
 * updated/deleted through emitWebhookDeliveries, the upstream `!IsDraft`
 * gate: drafts emit nothing).
 *
 * Findings-links N2 (the git-tag parity fix): a create with a FRESH
 * `tag_name` now also lands the GIT TAG through the shared tag-store service
 * (upstream release.go CreateRelease → createTag). Pinned here over REAL
 * engine content (the push-stale.test.ts direct-seeding shape — a real
 * `main` branch in the cf-gitea-stub/rel cell, persisted per file):
 * the fresh tag lists in GET /tags and resolves by name (the
 * `/src/tag/{tag}` link family's backing ref), an EXISTING tag rides without
 * a duplicate, an unresolvable `target_commitish` answers upstream's exact
 * 404 "target not found" with NO row created, an omitted target defaults to
 * the default branch, a draft creates NO tag (createTag's !IsDraft gate),
 * `tag_message` creates the ANNOTATED tag object, and the release-specific
 * protected-tag 422 message.
 *
 * The kept-open tail (this change) — createTag's post-write fill
 * (release.go:148-158): a published release's row carries sha1 = the tagged
 * commit (annotated tags peel), num_commits = the commit depth at it,
 * created_unix = the COMMIT's committer time (rendered straight through the
 * API's created_at); the ride-existing and §2.3 conversion arms fill alike,
 * and the draft arm stays unfilled (sha1 null, num_commits 0, created = the
 * row time) until publish.
 */

import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { protectedTags, releaseAssets, releases, repositories, users, webhookDeliveries, webhooks } from "../db/schema";
import { IssuesService } from "../issues/service";
import { createOptionalTokenAuthMiddleware, createStubAuthResolver, createTokenAuthMiddleware } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { ZERO_OID, branchRef, tagRef } from "./services/engine";
import { registerActivityFeedRoutes } from "./routes/activity-feeds";
import { registerReleaseRoutes } from "./routes/releases";
import { registerTagRoutes } from "./routes/tags";
import { applyRepoExtrasDdl, resetRepoExtrasTables } from "./testing/repo-ddl";
import { saveRepoSettings } from "./services/repo-settings";

const TOKEN = "stub-token";
const ERROR_URL = "https://example.com/api/swagger";
const REPO_PATH = "/repos/cf-gitea-stub/rel";
const jsonAuth = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };

/** Worker-side object hash (workerd crypto.subtle; putApiObjects re-verifies). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The seeded engine facts every N2 pin reads (beforeAll). */
let MAIN_TIP = "";
let RIDE_TAG_TIP = "";

function makeApp(): (path: string, init?: RequestInit) => Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerReleaseRoutes(app, createTokenAuthMiddleware(createStubAuthResolver()), createOptionalTokenAuthMiddleware(createStubAuthResolver()));
  // The tags family mounts too — the N2 pins read the created tag through
  // GET /tags + GET /tags/{tag}, the same engine refs the /src/tag/{tag}
  // UI link family resolves.
  registerTagRoutes(app, createTokenAuthMiddleware(createStubAuthResolver()), createOptionalTokenAuthMiddleware(createStubAuthResolver()));
  return (path, init) => Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

async function seedRelease(options: {
  tag: string;
  title?: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
  isTag?: boolean;
  minutesOffset?: number;
}): Promise<number> {
  const now = new Date(Date.parse("2026-03-01T00:00:00Z") + (options.minutesOffset ?? 0) * 60_000);
  const row = await new IssuesService(env.DB).createRelease({
    repoId: "7301",
    publisherId: 1,
    tagName: options.tag,
    target: "main",
    title: options.title ?? options.tag,
    note: `notes for ${options.tag}`,
    isDraft: options.isDraft,
    isPrerelease: options.isPrerelease,
    isTag: options.isTag,
    now,
  });
  return row.id;
}

/** Active webhook subscribed to the given events — the fan-out matcher target. */
async function seedHook(repoId: string, events: string[]): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(webhooks)
    .values({
      repoId,
      url: "https://hooks.invalid/release-test",
      events: JSON.stringify({ choose_events: true, branch_filter: "*", events: Object.fromEntries(events.map((e) => [e, true])) }),
      isActive: true,
      type: "gitea",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: webhooks.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("hook seed failed");
  return row.id;
}

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

async function deliveriesFor(hookId: number): Promise<DeliveryRow[]> {
  return drizzle(env.DB).select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
}

beforeAll(async () => {
  await applyRepoExtrasDdl();
  // The engine content the N2 pins resolve against: `main` at a two-commit
  // history plus a pre-existing `ride-tag` (the existing-tag-rides pin's
  // fixture) — direct-seeded into the cf-gitea-stub/rel cell the same way
  // push-stale.test.ts seeds its cells (DO storage persists per file, the
  // D1 wipes in beforeEach never touch it; the guard keeps a re-entered
  // beforeAll idempotent).
  const cell = env.REPO.getByName("cf-gitea-stub/rel");
  const refs = await cell.listRefs();
  const hasMain = (refs.refs ?? []).some((ref) => ref.name === "refs/heads/main");
  if (!hasMain) {
    const person = { name: "seed", email: "seed@rel.invalid", time: 1761000000, tz: "+0000" };
    const readme = new TextEncoder().encode("# rel\n");
    const readmeOid = await gitObjectOid("blob", readme);
    const tree = serializeTree([{ mode: "100644", name: "README.md", oid: readmeOid }]);
    const root = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "root\n" });
    const second = serializeCommit({ tree: tree.oid, parents: [root.oid], author: person, committer: person, message: "second\n" });
    const put = await cell.putApiObjects([
      { oid: readmeOid, type: "blob", data: readme },
      { oid: tree.oid, type: "tree", data: tree.data },
      { oid: root.oid, type: "commit", data: root.data },
      { oid: second.oid, type: "commit", data: second.data },
    ]);
    if (put.tag !== "ok") throw new Error(`seed putApiObjects failed: ${put.tag}`);
    for (const [ref, oid] of [
      [branchRef("main"), second.oid],
      [tagRef("ride-tag"), root.oid],
    ] as const) {
      const landed = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: oid });
      if (landed.tag !== "committed") throw new Error(`seed ref landing failed: ${ref}`);
    }
    MAIN_TIP = second.oid;
    RIDE_TAG_TIP = root.oid;
  } else {
    const main = (refs.refs ?? []).find((ref) => ref.name === "refs/heads/main");
    const ride = (refs.refs ?? []).find((ref) => ref.name === "refs/tags/ride-tag");
    MAIN_TIP = main?.target ?? "";
    RIDE_TAG_TIP = ride?.target ?? "";
  }
});

beforeEach(async () => {
  await resetRepoExtrasTables();
  for (const table of ["webhook_deliveries", "webhooks", "release_assets", "releases", "action", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  await drizzle(env.DB).insert(repositories).values({
    id: "7301",
    storageKey: "r_7301",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "rel",
    visibility: "public",
    // Non-empty repo: the create gate is is_empty (the settle-maintained
    // column — refs_version is observability-only and never synced, the
    // REDEPLOY14 finding that closed d24dc0f).
    refsVersion: 1,
    isEmpty: false,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await drizzle(env.DB).insert(repositories).values({
    id: "7302",
    storageKey: "r_7302",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "empty",
    visibility: "public",
    refsVersion: 0,
    isEmpty: true,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
});

describe("POST /repos/{owner}/{repo}/releases (repoCreateRelease)", () => {
  it("creates a release and renders the URL family", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v1.0.0", name: "First", body: "notes", target_commitish: "main" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.id).toBeGreaterThan(0);
    expect(body.tag_name).toBe("v1.0.0");
    expect(body.name).toBe("First");
    expect(body.body).toBe("notes");
    expect(body.draft).toBe(false);
    expect(body.prerelease).toBe(false);
    expect(body.url).toBe(`https://example.com/api/v1/repos/cf-gitea-stub/rel/releases/${String(body.id)}`);
    expect(body.html_url).toBe("https://example.com/cf-gitea-stub/rel/releases/tag/v1.0.0");
    expect(body.tarball_url).toBe("https://example.com/cf-gitea-stub/rel/archive/v1.0.0.tar.gz");
    expect(body.zipball_url).toBe("https://example.com/cf-gitea-stub/rel/archive/v1.0.0.zip");
    expect(body.upload_url).toBe(`https://example.com/api/v1/repos/cf-gitea-stub/rel/releases/${String(body.id)}/assets`);
    expect(body.target_commitish).toBe("main");
    expect(body.published_at).toBeTypeOf("string");
    expect((body.author as Record<string, unknown>).login).toBe("cf-gitea-stub");
    expect(body.assets).toEqual([]);
  });

  it("409s a duplicate tag with the upstream ReleaseAlreadyExist message", async () => {
    await seedRelease({ tag: "v1.0.0" });
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v1.0.0" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ message: "release tag already exist [tag_name: v1.0.0]", url: ERROR_URL });
  });

  it("converts a tag-only record on the same tag (§2.3)", async () => {
    const tagOnlyId = await seedRelease({ tag: "v2.0.0", isTag: true });
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v2.0.0", name: "Converted" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json<Record<string, unknown>>()).id).toBe(tagOnlyId);
  });

  it("422s an empty repo (refs_version 0, upstream 'repo is empty')", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/empty/releases", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v1" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: "repo is empty", url: ERROR_URL });
  });

  it("creates a draft (published_at null) and a prerelease", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v0.1.0", draft: true, prerelease: true }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.draft).toBe(true);
    expect(body.prerelease).toBe(true);
    expect(body.published_at).toBeNull();
  });

  it("defaults target_commitish to the default branch", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v3.0.0" }),
    });
    expect((await res.json<Record<string, unknown>>()).target_commitish).toBe("main");
  });

  it("does NOT 423 on an archived repo (the pin registers no mustNotBeArchived here)", async () => {
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, "7301"));
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v4.0.0" }),
    });
    expect(res.status).toBe(201);
  });

  it("401s an anonymous caller", async () => {
    expect((await makeApp()(`${REPO_PATH}/releases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("422s a malformed body", async () => {
    expect((await makeApp()(`${REPO_PATH}/releases`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ name: "no tag" }) })).status).toBe(422);
  });

  // -------------------------------------------------------------------------
  // Findings-links N2 — the release create also lands the GIT TAG (upstream
  // release.go CreateRelease → release_service.CreateRelease → createTag).
  // -------------------------------------------------------------------------

  it("creates the git tag for a fresh tag_name: GET /tags lists it and it resolves (N2)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "n2-fresh", name: "N2", target_commitish: "main" }),
    });
    expect(res.status).toBe(201);

    const list = await makeApp()(`${REPO_PATH}/tags`);
    expect(list.status).toBe(200);
    expect((await list.json<Array<{ name: string }>>()).map((tag) => tag.name)).toContain("n2-fresh");

    const one = await makeApp()(`${REPO_PATH}/tags/n2-fresh`);
    expect(one.status).toBe(200);
    const tag = await one.json<{ id: string; commit: { sha: string } }>();
    expect(tag.commit.sha).toBe(MAIN_TIP); // the target_commitish tip
    expect(tag.id).toBe(MAIN_TIP); // lightweight: the ref target IS the commit
  });

  it("resolves the created tag's /src/tag/{tag} link (the git-tag-shaped URL family N2 unbreaks)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "n2-ui", target_commitish: "main" }),
    });
    expect(res.status).toBe(201);
    // The full worker app — the UI router's file view resolving the tag ref.
    const page = await SELF.fetch(`https://example.com/cf-gitea-stub/rel/src/tag/n2-ui`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("README"); // the repo tree AT the tag rendered
  });

  it("rides an existing git tag without duplicating it (upstream IsTagExist, release.go:78)", async () => {
    const before = await makeApp()(`${REPO_PATH}/tags`);
    const beforeList = await before.json<Array<{ name: string }>>();
    expect(beforeList.map((tag) => tag.name)).toContain("ride-tag");

    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "ride-tag", name: "Rides" }),
    });
    expect(res.status).toBe(201);

    const after = await makeApp()(`${REPO_PATH}/tags`);
    const afterList = await after.json<Array<{ name: string }>>();
    expect(afterList.filter((tag) => tag.name === "ride-tag")).toHaveLength(1); // no duplicate ref
    const one = await makeApp()(`${REPO_PATH}/tags/ride-tag`);
    expect((await one.json<{ commit: { sha: string } }>()).commit.sha).toBe(RIDE_TAG_TIP); // untouched target
  });

  it("404s 'target not found' on an unresolvable target_commitish and creates NO row (release.go:283)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "n2-bad-target", target_commitish: "no-such-branch" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "target not found", url: ERROR_URL });
    // The upstream gate runs BEFORE the insert — no orphan release row, and
    // no git tag either.
    expect(await drizzle(env.DB).select().from(releases).all()).toEqual([]);
    expect((await makeApp()(`${REPO_PATH}/tags/n2-bad-target`)).status).toBe(404);
  });

  it("defaults the tag to the default branch when target_commitish is omitted (release.go:260-262)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "n2-default" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json<Record<string, unknown>>()).target_commitish).toBe("main");
    const one = await makeApp()(`${REPO_PATH}/tags/n2-default`);
    expect(one.status).toBe(200);
    expect((await one.json<{ commit: { sha: string } }>()).commit.sha).toBe(MAIN_TIP);
  });

  it("creates NO git tag for a draft (createTag's !IsDraft gate, release.go:78)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "n2-draft", draft: true }),
    });
    expect(res.status).toBe(201);
    expect((await makeApp()(`${REPO_PATH}/tags/n2-draft`)).status).toBe(404);
  });

  it("creates an ANNOTATED tag object when tag_message is set (release.go:110-121)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "n2-annotated", tag_message: "annotated note" }),
    });
    expect(res.status).toBe(201);
    const one = await makeApp()(`${REPO_PATH}/tags/n2-annotated`);
    expect(one.status).toBe(200);
    const tag = await one.json<{ id: string; commit: { sha: string } }>();
    expect(tag.commit.sha).toBe(MAIN_TIP); // peeled to the target commit
    expect(tag.id).not.toBe(MAIN_TIP); // the ref target is the TAG OBJECT
  });

  // -----------------------------------------------------------------------
  // The kept-open tail — createTag's post-write fill (release.go:148-158):
  // for EVERY resolved tag (fresh, ridden, §2.3 conversion) the row's
  // sha1 = the tagged commit, num_commits = the commit depth at it, and
  // created_unix = the COMMIT's committer time (dated by its commit, "so an
  // old commit does not become the latest release", release.go:154). The
  // seed's two commits both carry committer time 1761000000 (beforeAll's
  // person), main's depth at its tip is 2 and at ride-tag's root 1.
  // -----------------------------------------------------------------------

  async function releaseRow(tag: string): Promise<typeof releases.$inferSelect> {
    const row = await drizzle(env.DB).select().from(releases).where(eq(releases.tagName, tag)).get();
    if (row === undefined) throw new Error(`release row missing: ${tag}`);
    return row;
  }

  const SEED_COMMIT_ISO = new Date(1761000000 * 1000).toISOString(); // the seed commits' committer time

  it("fills sha1/num_commits/created from the tagged commit (created arm, release.go:148-158)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "fill-main", name: "Fill", target_commitish: "main" }),
    });
    expect(res.status).toBe(201);
    const row = await releaseRow("fill-main");
    expect(row.sha1).toBe(MAIN_TIP); // the tagged commit (the light tag's tip)
    expect(row.numCommits).toBe(2); // the branch depth at the tag (root + second)
    expect(row.createdAt?.toISOString()).toBe(SEED_COMMIT_ISO); // the COMMIT time, not the row time
    // The API response renders the fill (ToAPIRelease CreatedAt ← CreatedUnix).
    expect((await res.json<Record<string, unknown>>()).created_at).toBe(SEED_COMMIT_ISO);
  });

  it("peels an annotated tag's fill to its commit (sha1 ≠ the tag object oid)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "fill-annotated", tag_message: "annotated" }),
    });
    expect(res.status).toBe(201);
    const row = await releaseRow("fill-annotated");
    expect(row.sha1).toBe(MAIN_TIP); // the COMMIT, not the tag object (GetTagCommit's dereference)
    expect(row.numCommits).toBe(2);
    expect(row.createdAt?.toISOString()).toBe(SEED_COMMIT_ISO);
  });

  it("fills the ride-existing arm too (the fill sits after createTag's tag arm)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "ride-tag", name: "Rides" }),
    });
    expect(res.status).toBe(201);
    const row = await releaseRow("ride-tag");
    expect(row.sha1).toBe(RIDE_TAG_TIP); // the pre-existing tag's commit (root)
    expect(row.numCommits).toBe(1); // depth AT the root: one commit
    expect(row.createdAt?.toISOString()).toBe(SEED_COMMIT_ISO);
  });

  it("converts a tag-only record WITH the fill (§2.3 + release.go:148-158)", async () => {
    const tagOnlyId = await seedRelease({ tag: "fill-conv", isTag: true, minutesOffset: 0 });
    const before = await releaseRow("fill-conv");
    expect(before.createdAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z"); // the tag record's own time, pre-conversion
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "fill-conv", name: "Converted" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json<Record<string, unknown>>()).id).toBe(tagOnlyId);
    const row = await releaseRow("fill-conv");
    expect(row.sha1).toBe(MAIN_TIP);
    expect(row.numCommits).toBe(2);
    expect(row.createdAt?.toISOString()).toBe(SEED_COMMIT_ISO); // the fill OVERWRITES the record's creation time
  });

  it("leaves the draft arm unfilled until publish (createTag's else arm, release.go:166-168)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "fill-draft", draft: true }),
    });
    expect(res.status).toBe(201);
    const row = await releaseRow("fill-draft");
    expect(row.sha1).toBeNull();
    expect(row.numCommits).toBe(0);
    expect(row.createdAt?.toISOString()).not.toBe(SEED_COMMIT_ISO); // the ROW time (2026), not the commit's
    expect(row.createdAt?.getTime()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    // No git tag exists to fill FROM (the publish-time fill rides the still-open
    // UpdateRelease tag arm — see services/releases.ts's draft-posture note).
    expect((await makeApp()(`${REPO_PATH}/tags/fill-draft`)).status).toBe(404);
  });

  it("422s the release-specific protected-tag message on a fresh protected tag (release.go:281)", async () => {
    await drizzle(env.DB).insert(protectedTags).values({
      repoId: "7301",
      namePattern: "n2-prot-*",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      const res = await makeApp()(`${REPO_PATH}/releases`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ tag_name: "n2-prot-tag" }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        message: "release tag name is protected [tag_name: n2-prot-tag]",
        url: ERROR_URL,
      });
      expect(await drizzle(env.DB).select().from(releases).all()).toEqual([]); // no row, like upstream
    } finally {
      await drizzle(env.DB).delete(protectedTags).where(eq(protectedTags.repoId, "7301"));
    }
  });
});

describe("GET /repos/{owner}/{repo}/releases (repoListReleases)", () => {
  beforeEach(async () => {
    await seedRelease({ tag: "v1", minutesOffset: 0 });
    await seedRelease({ tag: "v2", minutesOffset: 1 });
    await seedRelease({ tag: "v3-draft", isDraft: true, minutesOffset: 2 });
    await seedRelease({ tag: "v4-pre", isPrerelease: true, minutesOffset: 3 });
    await seedRelease({ tag: "pure-tag", isTag: true, minutesOffset: 4 });
  });

  it("lists newest-first, hiding drafts (anonymous) and tag-only rows; prereleases stay", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    const body = await res.json<Array<{ tag_name: string }>>();
    expect(body.map((r) => r.tag_name)).toEqual(["v4-pre", "v2", "v1"]);
  });

  it("shows drafts to a writer, and honors the draft/pre-release/tag_filter queries", async () => {
    const seen = await makeApp()(`${REPO_PATH}/releases`, { headers: { Authorization: `token ${TOKEN}` } });
    expect(seen.headers.get("X-Total-Count")).toBe("4"); // v1, v2, v3-draft, v4-pre
    const draftsOnly = await makeApp()(`${REPO_PATH}/releases?draft=true`, { headers: { Authorization: `token ${TOKEN}` } });
    expect((await draftsOnly.json<Array<{ tag_name: string }>>()).map((r) => r.tag_name)).toEqual(["v3-draft"]);
    const draftsAnon = await makeApp()(`${REPO_PATH}/releases?draft=true`);
    expect(await draftsAnon.json()).toEqual([]); // no write access → nothing
    const pre = await makeApp()(`${REPO_PATH}/releases?pre-release=true`);
    expect((await pre.json<Array<{ tag_name: string }>>()).map((r) => r.tag_name)).toEqual(["v4-pre"]);
    const filtered = await makeApp()(`${REPO_PATH}/releases?tag_filter=v*`);
    expect((await filtered.json<Array<{ tag_name: string }>>()).length).toBeGreaterThanOrEqual(2);

    // The glob translation pins (the arm is instr()-translated — the
    // 943e1e9 org-members shape — so the upstream release.go:302-309
    // semantics ride on explicit probes, not the LIKE engine): suffix,
    // middle, plain substring, `%`/`_` literal (upstream escapes them),
    // the no-overlap suffix rule, and the 50-byte-cap boundary — 200-char
    // needles answer the clean empty list, not a D1_ERROR 500.
    const suffixGlob = await makeApp()(`${REPO_PATH}/releases?tag_filter=*pre`);
    expect((await suffixGlob.json<Array<{ tag_name: string }>>()).map((r) => r.tag_name)).toEqual(["v4-pre"]);
    const middleGlob = await makeApp()(`${REPO_PATH}/releases?tag_filter=*2*`);
    expect((await middleGlob.json<Array<{ tag_name: string }>>()).map((r) => r.tag_name)).toEqual(["v2"]);
    const substring = await makeApp()(`${REPO_PATH}/releases?tag_filter=1`);
    expect((await substring.json<Array<{ tag_name: string }>>()).map((r) => r.tag_name)).toEqual(["v1"]);
    const literalUnderscore = await makeApp()(`${REPO_PATH}/releases?tag_filter=v_`);
    expect((await literalUnderscore.json<Array<{ tag_name: string }>>()).map((r) => r.tag_name)).toEqual([]);
    const overlapRule = await makeApp()(`${REPO_PATH}/releases?tag_filter=v2*2`);
    expect((await overlapRule.json<Array<{ tag_name: string }>>()).map((r) => r.tag_name)).toEqual([]);
    const longNeedle = await makeApp()(`${REPO_PATH}/releases?tag_filter=${"z".repeat(200)}`);
    expect(longNeedle.status).toBe(200);
    expect(await longNeedle.json()).toEqual([]);
    const longGlob = await makeApp()(`${REPO_PATH}/releases?tag_filter=${"z".repeat(120)}*${"z".repeat(120)}`);
    expect(longGlob.status).toBe(200);
    expect(await longGlob.json()).toEqual([]);
  });

  it("paginates with the Link header", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases?limit=1`);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    expect(res.headers.get("Link")).toContain('rel="next"');
    expect(res.headers.get("Link")).toContain('rel="last"');
  });

  it("412s when the stored has_releases flag is off (mustEnableUnit, runtime-only)", async () => {
    await saveRepoSettings(env.DB, "7301", { hasReleases: false }, new Date());
    const res = await makeApp()(`${REPO_PATH}/releases`, { headers: { Authorization: `token ${TOKEN}` } });
    expect(res.status).toBe(412);
  });
});

describe("GET /repos/{owner}/{repo}/releases/latest (repoGetLatestRelease)", () => {
  it("returns the newest non-draft, non-prerelease, non-tag release", async () => {
    await seedRelease({ tag: "v1", minutesOffset: 0 });
    await seedRelease({ tag: "v2", minutesOffset: 1 });
    await seedRelease({ tag: "v3-draft", isDraft: true, minutesOffset: 2 });
    await seedRelease({ tag: "v4-pre", isPrerelease: true, minutesOffset: 3 });
    await seedRelease({ tag: "v5-tag", isTag: true, minutesOffset: 4 });
    const res = await makeApp()(`${REPO_PATH}/releases/latest`);
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).tag_name).toBe("v2");
  });

  it("404s when only drafts/prereleases exist", async () => {
    await seedRelease({ tag: "v1", isDraft: true });
    expect((await makeApp()(`${REPO_PATH}/releases/latest`)).status).toBe(404);
  });

  it("404s a release-less repo", async () => {
    expect((await makeApp()(`${REPO_PATH}/releases/latest`)).status).toBe(404);
  });
});

describe("GET/DELETE /repos/{owner}/{repo}/releases/tags/{tag}", () => {
  beforeEach(async () => {
    await seedRelease({ tag: "V1.0", minutesOffset: 0 }); // stored case kept
    await seedRelease({ tag: "draft-tag", isDraft: true, minutesOffset: 1 });
    await seedRelease({ tag: "pure-tag", isTag: true, minutesOffset: 2 });
  });

  it("resolves case-insensitively by tag", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases/tags/v1.0`);
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).tag_name).toBe("V1.0");
  });

  it("404s a missing tag, a tag-only record, and a draft for anonymous readers", async () => {
    expect((await makeApp()(`${REPO_PATH}/releases/tags/nope`)).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/tags/pure-tag`)).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/tags/draft-tag`)).status).toBe(404);
    // …but the writer sees the draft.
    expect((await makeApp()(`${REPO_PATH}/releases/tags/draft-tag`, { headers: { Authorization: `token ${TOKEN}` } })).status).toBe(200);
  });

  it("deletes by tag (204) and 404s afterwards", async () => {
    expect((await makeApp()(`${REPO_PATH}/releases/tags/v1.0`, { method: "DELETE", headers: jsonAuth })).status).toBe(204);
    expect((await makeApp()(`${REPO_PATH}/releases/tags/v1.0`)).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/tags/v1.0`, { method: "DELETE", headers: jsonAuth })).status).toBe(404);
  });

  it("refuses to delete a tag-only record (404) and requires a token", async () => {
    expect((await makeApp()(`${REPO_PATH}/releases/tags/pure-tag`, { method: "DELETE", headers: jsonAuth })).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/tags/v1.0`, { method: "DELETE" })).status).toBe(401);
  });
});

describe("GET/PATCH/DELETE /repos/{owner}/{repo}/releases/{id} (global id, repo-scoped)", () => {
  let releaseId = 0;
  let draftId = 0;
  let tagOnlyId = 0;

  beforeEach(async () => {
    releaseId = await seedRelease({ tag: "v1", title: "One", minutesOffset: 0 });
    draftId = await seedRelease({ tag: "v2-draft", isDraft: true, minutesOffset: 1 });
    tagOnlyId = await seedRelease({ tag: "pure-tag", isTag: true, minutesOffset: 2 });
  });

  it("gets by global id", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}`);
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.id).toBe(releaseId);
    expect(body.name).toBe("One");
  });

  it("404s a foreign-repo id, a tag-only record, a draft (anon), and garbage", async () => {
    await drizzle(env.DB).insert(repositories).values({
      id: "7309",
      storageKey: "r_7309",
      ownerNamespace: "cf-gitea-stub",
      ownerId: 1,
      slug: "other",
      visibility: "public",
      refsVersion: 1,
      isEmpty: false,
      backend: "self-hosted",
      createdAt: new Date(),
    });
    expect((await makeApp()("/repos/cf-gitea-stub/other/releases/" + releaseId)).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/${tagOnlyId}`)).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/${draftId}`)).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/${draftId}`, { headers: { Authorization: `token ${TOKEN}` } })).status).toBe(200);
    expect((await makeApp()(`${REPO_PATH}/releases/not-a-number`)).status).toBe(404);
  });

  it("patches only the set fields and keeps empty strings as no-ops", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ name: "Renamed", body: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("Renamed");
    expect(body.body).toBe("notes for v1"); // empty string = untouched
    expect(body.tag_name).toBe("v1");
  });

  it("publishing a draft stamps published_at", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases/${draftId}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ draft: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.draft).toBe(false);
    expect(body.published_at).toBeTypeOf("string");
  });

  it("renames the tag (D1-only; the git tag is the engine wave)", async () => {
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v1-renamed" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).tag_name).toBe("v1-renamed");
    expect((await makeApp()(`${REPO_PATH}/releases/tags/v1-renamed`)).status).toBe(200);
  });

  it("404s the PATCH on a missing/tag-only release", async () => {
    expect((await makeApp()(`${REPO_PATH}/releases/9999`, { method: "PATCH", headers: jsonAuth, body: "{}" })).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/${tagOnlyId}`, { method: "PATCH", headers: jsonAuth, body: "{}" })).status).toBe(404);
  });

  it("deletes by id with the asset rows", async () => {
    await drizzle(env.DB).insert(releaseAssets).values({
      uuid: "u-1",
      repoId: "7301",
      releaseId,
      name: "bin.zip",
      size: 10,
      r2Key: "repos/r_7301/assets/u-1",
      createdAt: new Date(),
    });
    expect((await makeApp()(`${REPO_PATH}/releases/${releaseId}`, { method: "DELETE", headers: jsonAuth })).status).toBe(204);
    expect(await drizzle(env.DB).select().from(releases).where(eq(releases.id, releaseId)).all()).toEqual([]);
    expect(await drizzle(env.DB).select().from(releaseAssets).where(eq(releaseAssets.releaseId, releaseId)).all()).toEqual([]);
  });

  it("404s the DELETE on a missing/tag-only release and 401s anonymously", async () => {
    expect((await makeApp()(`${REPO_PATH}/releases/9999`, { method: "DELETE", headers: jsonAuth })).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/${tagOnlyId}`, { method: "DELETE", headers: jsonAuth })).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/${releaseId}`, { method: "DELETE" })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// `release` webhook emissions (upstream sendReleaseHook:879 — NewRelease:889
// "published" / UpdateRelease:893 "updated" / DeleteRelease:897 "deleted",
// all gated on `!rel.IsDraft`, services/release/release.go:198,358,435).
// ---------------------------------------------------------------------------

describe("release webhook emissions (repoCreateRelease/repoEditRelease/repoDeleteRelease)", () => {
  it("emits `release` action=published on create, with the upstream ReleasePayload field set", async () => {
    const hookId = await seedHook("7301", ["release"]);

    const res = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v1.0.0", name: "First", body: "notes" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json<{ id: number; tag_name: string }>()).id;

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect(delivery.eventType).toBe("release");
    expect(delivery.eventGroup).toBe("release"); // not in EVENT_GROUPS → identity group
    expect(delivery.repoId).toBe("7301");
    expect(delivery.state).toBe("pending"); // in-process tests skip the Queue enqueue
    const payload = JSON.parse(delivery.payloadContent) as Record<string, unknown>;
    // §2.7 ReleasePayload (hook.go:332): action/release/repository/sender.
    expect(Object.keys(payload).sort()).toEqual(["action", "release", "repository", "sender"]);
    expect(payload.action).toBe("published"); // NewRelease, never "created"
    expect(payload.release).toMatchObject({ id: created, tag_name: "v1.0.0", name: "First", draft: false });
    expect(payload.repository).toMatchObject({ full_name: "cf-gitea-stub/rel" });
    expect(payload.sender).toMatchObject({ login: "cf-gitea-stub" });
    expect(delivery.payloadContent).toContain('\n  "action": "published"'); // 2-space §2.7 serialization
  });

  it("emits `updated` on edit and `published` on the draft→published flip (upstream isTagCreated arm)", async () => {
    const hookId = await seedHook("7301", ["release"]);
    const releaseId = await seedRelease({ tag: "v1", minutesOffset: 0 });
    const draftId = await seedRelease({ tag: "v2-draft", isDraft: true, minutesOffset: 1 });
    expect(await deliveriesFor(hookId)).toHaveLength(0); // seedRelease is not a route write

    const renamed = await makeApp()(`${REPO_PATH}/releases/${releaseId}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(renamed.status).toBe(200);

    const published = await makeApp()(`${REPO_PATH}/releases/${draftId}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ draft: false }),
    });
    expect(published.status).toBe(200);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action)).toEqual(["updated", "published"]);
    expect((JSON.parse(deliveries[0]!.payloadContent) as { release: { tag_name: string } }).release.tag_name).toBe("v1");
    expect((JSON.parse(deliveries[1]!.payloadContent) as { release: { tag_name: string } }).release.tag_name).toBe("v2-draft");
  });

  it("stays silent while a release is a draft (create, edit, delete) and on a lost PATCH race", async () => {
    const hookId = await seedHook("7301", ["release"]);

    const created = await makeApp()(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v0-draft", draft: true }),
    });
    expect(created.status).toBe(201);
    const draftId = (await created.json<{ id: number }>()).id;

    const edited = await makeApp()(`${REPO_PATH}/releases/${draftId}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ name: "still draft" }),
    });
    expect(edited.status).toBe(200);

    const deleted = await makeApp()(`${REPO_PATH}/releases/${draftId}`, { method: "DELETE", headers: jsonAuth });
    expect(deleted.status).toBe(204);

    expect(await deliveriesFor(hookId)).toHaveLength(0); // upstream: drafts never notify
  });

  it("emits `deleted` on both delete routes and nothing for a non-subscribed hook", async () => {
    const releaseId = await seedRelease({ tag: "v1", minutesOffset: 0 });
    await seedRelease({ tag: "v2", minutesOffset: 1 });
    const releaseHook = await seedHook("7301", ["release"]);
    const pushHook = await seedHook("7301", ["push"]); // not subscribed to release

    expect((await makeApp()(`${REPO_PATH}/releases/tags/v2`, { method: "DELETE", headers: jsonAuth })).status).toBe(204);
    expect((await makeApp()(`${REPO_PATH}/releases/${releaseId}`, { method: "DELETE", headers: jsonAuth })).status).toBe(204);

    const deliveries = await deliveriesFor(releaseHook);
    expect(deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action)).toEqual(["deleted", "deleted"]);
    expect((JSON.parse(deliveries[0]!.payloadContent) as { release: { tag_name: string } }).release.tag_name).toBe("v2");
    expect((JSON.parse(deliveries[1]!.payloadContent) as { release: { tag_name: string } }).release.tag_name).toBe("v1");
    expect(await deliveriesFor(pushHook)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Activity feeds — the publish_release `action` row (specs/activity-feeds.md
// §3.3): upstream's actionNotifier.NewRelease (services/feed/notifier.go
// :458-477) writes it ONLY for the "published" action — content = rel.Title,
// ref_name = refs/tags/<tag> (git.RefNameFromTag(rel.TagName).String()),
// act_user = the RELEASE PUBLISHER (rel.PublisherID, not the flipping doer).
// updated/deleted write none; drafts never reach the seam (the !IsDraft gate).
// ---------------------------------------------------------------------------

/** The releases family + the feeds read, one mount. */
function feedsApp(): (path: string, init?: RequestInit) => Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  const auth = createTokenAuthMiddleware(createStubAuthResolver());
  const optional = createOptionalTokenAuthMiddleware(createStubAuthResolver());
  registerReleaseRoutes(app, auth, optional);
  registerActivityFeedRoutes(app, auth, optional);
  return (path, init) => Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

describe("activity feeds — publish_release action rows", () => {
  it("POST a non-draft release records publish_release with content=title and ref_name=refs/tags/<tag>", async () => {
    const app = feedsApp();
    const created = await app(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v1.0", name: "First release" }),
    });
    expect(created.status).toBe(201);
    const feed = await app(`${REPO_PATH}/activities/feeds`);
    expect(feed.status).toBe(200);
    const body = await feed.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      op_type: "publish_release",
      content: "First release",
      ref_name: "refs/tags/v1.0",
      act_user_id: 1,
      is_private: false,
    });
  });

  it("drafts stay silent; the draft→published PATCH records the row with the RELEASE PUBLISHER as act_user (rel.PublisherID, not the flipping doer)", async () => {
    await drizzle(env.DB).insert(users).values({
      id: 2,
      username: "publisher",
      usernameLower: "publisher",
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    // The doer is the stub (id 1); the release is PUBLISHED BY user 2 — the
    // action row must keep the publisher (upstream acts on rel.Publisher).
    const row = await new IssuesService(env.DB).createRelease({
      repoId: "7301",
      publisherId: 2,
      tagName: "v2.0",
      target: "main",
      title: "Publisher's release",
      note: "",
      isDraft: true,
    });
    const app = feedsApp();
    expect((await (await app(`${REPO_PATH}/activities/feeds`)).json<unknown[]>()).length).toBe(0);

    const patched = await app(`${REPO_PATH}/releases/${row.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ draft: false }),
    });
    expect(patched.status).toBe(200);

    const body = (await (await app(`${REPO_PATH}/activities/feeds`)).json<Array<Record<string, unknown>>>());
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      op_type: "publish_release",
      content: "Publisher's release",
      ref_name: "refs/tags/v2.0",
      act_user_id: 2, // the publisher — NOT the doer (id 1) who flipped the draft
    });
  });

  it("updated/deleted release actions record NO row", async () => {
    const app = feedsApp();
    const created = await app(`${REPO_PATH}/releases`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tag_name: "v3.0", name: "Third" }),
    });
    expect(created.status).toBe(201);
    const releaseId = (await created.json<{ id: number }>()).id;

    expect(
      (
        await app(`${REPO_PATH}/releases/${releaseId}`, {
          method: "PATCH",
          headers: jsonAuth,
          body: JSON.stringify({ name: "Renamed" }),
        })
      ).status,
    ).toBe(200);
    expect((await app(`${REPO_PATH}/releases/${releaseId}`, { method: "DELETE", headers: jsonAuth })).status).toBe(204);

    // Only the original publish — updated/deleted write none (notifier.go has
    // no UpdateRelease/DeleteRelease action method).
    const body = (await (await app(`${REPO_PATH}/activities/feeds`)).json<Array<Record<string, unknown>>>());
    expect(body).toHaveLength(1);
    expect(body[0]?.op_type).toBe("publish_release");
    expect(body[0]?.content).toBe("Third");
  });
});
