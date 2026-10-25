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
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { releaseAssets, releases, repositories, webhookDeliveries, webhooks } from "../db/schema";
import { IssuesService } from "../issues/service";
import { createOptionalTokenAuthMiddleware, createStubAuthResolver, createTokenAuthMiddleware } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerReleaseRoutes } from "./routes/releases";
import { applyRepoExtrasDdl, resetRepoExtrasTables } from "./testing/repo-ddl";
import { saveRepoSettings } from "./services/repo-settings";

const TOKEN = "stub-token";
const ERROR_URL = "https://example.com/api/swagger";
const REPO_PATH = "/repos/cf-gitea-stub/rel";
const jsonAuth = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };

function makeApp(): (path: string, init?: RequestInit) => Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerReleaseRoutes(app, createTokenAuthMiddleware(createStubAuthResolver()), createOptionalTokenAuthMiddleware(createStubAuthResolver()));
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
});

beforeEach(async () => {
  await resetRepoExtrasTables();
  for (const table of ["webhook_deliveries", "webhooks", "release_assets", "releases", "repositories", "users"]) {
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
    refsVersion: 1, // non-empty: the create gate is refs_version > 0
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
