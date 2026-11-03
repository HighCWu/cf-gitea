/**
 * Tag-name addressability — the /repos/{owner}/{repo}/tags/{tag} wildcard
 * siblings (repoGetTag / repoDeleteTag).
 *
 * Upstream DECLARES {tag} single-segment in its swagger but registers the two
 * name-addressed ops under chi catch-alls (`m.Get("/*", repo.GetTag)` /
 * `m.Delete("/*", ...)` — routers/api/v1/api.go:1333-1338) reading the name
 * with `ctx.PathParam("*")` (routers/api/v1/repo/tag.go:153/:269) — tag names
 * git allows that contain slashes (`release/v1.2`) address correctly on
 * upstream's wire. Ours mirrors that runtime shape: the declared {tag} routes
 * stay verbatim, each with a plain-Hono `/repos/:owner/:repo/tags/*` sibling
 * sharing the same handler core (the branch-protections module's pattern).
 *
 * Pinned here: both arms' agreement on the same tag (the literal-slash body
 * equals the declared route's %2F body), the wildcard DELETE arm and its
 * 404-after-delete, the gates kept on the wildcard arms (public read +
 * reqToken/reqRepoWriter on the write), and the mount-composition hazard —
 * hono keeps c.req.path UNSTRIPPED inside a .route()-mounted sub-app, so the
 * sibling's tail cut anchors on the `repos/{owner}/{repo}/tags` family shape
 * scanned from the LEFT, not a fixed depth (the branch-protections battery's
 * THE CATCH, green in a root-mount harness and 404 live until fixed there).
 *
 * Real engine content (the engine-read.test.ts seeding — REAL pushed packs
 * through the git-http receive flow): the slash tag is created through the
 * API itself (POST /tags is body-addressed, no wildcard needed), so every
 * arm runs against actual engine refs.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { protectedTags, releases, repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerTagRoutes } from "./tags";
import type { User } from "../models/user";

const ORIGIN = "https://apisuite.test";
const TOKEN = "tags-slash-token";
const OUTSIDER_TOKEN = "tags-slash-outsider";
const OWNER = "apisuite";
const SLUG = "tag-slash";
const REPO_PATH = `/repos/${OWNER}/${SLUG}`;

const T0 = 1_760_000_000;

const SEED_COMMITS: SeedCommit[] = [
  {
    message: "seed: initial layout",
    time: T0,
    files: [{ path: "README.md", content: "# tag-slash suite\n" }],
  },
  {
    message: "seed: second commit",
    time: T0 + 60,
    files: [{ path: "README.md", content: "# tag-slash suite\n" }, { path: "docs/deep.txt", content: "deep\n" }],
  },
];

let OWNER_ID = 1;
let TIP1 = "";
let TIP2 = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS, tags: [{ name: "v1.0.0", commitIndex: 1 }] });
  TIP1 = seeded.tips[0] as string;
  TIP2 = seeded.tips[1] as string;
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (row === undefined) throw new Error("seed owner missing");
  OWNER_ID = row.id;
});

/** The api-layer identity the suite token resolves to (the seeded owner). */
function identity(): User {
  return { ...STUB_USER, id: OWNER_ID, login: OWNER, full_name: OWNER, created: new Date(T0 * 1000).toISOString() };
}

const OUTSIDER_ID = 4242;

/** An authenticated NON-collaborator — visible on the public seed repo, no write. */
function outsiderIdentity(): User {
  return { ...STUB_USER, id: OUTSIDER_ID, login: "outsider", full_name: "outsider", created: new Date(T0 * 1000).toISOString() };
}

const resolver: AuthResolver = {
  resolveToken: (token: string) =>
    Promise.resolve(token === TOKEN ? identity() : token === OUTSIDER_TOKEN ? outsiderIdentity() : null),
};

/** Local mount — the deferred router.ts one-liner's exact seam. */
function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  registerTagRoutes(a, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return a;
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

const authed = (init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${TOKEN}` },
});

const authedAs = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}` },
});

const jsonInit = (method: string, body: unknown): RequestInit =>
  authed({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const get = async (path: string): Promise<Response> => app().fetch(new Request(`${ORIGIN}${path}`), env);
const send = async (path: string, init: RequestInit): Promise<Response> => app().fetch(new Request(`${ORIGIN}${path}`, init), env);

/** Creates the slashed tag through the body-addressed POST arm (annotated
 *  with a message, lightweight without) and returns the created render.
 *  Idempotent: the file's arms run in order on shared storage and a previous
 *  arm may have left the tag — the pre-DELETE clears it (status ignored). */
async function createSlashedTag(target: string, message?: string): Promise<Record<string, unknown>> {
  await send(`${REPO_PATH}/tags/release/v1.2`, authed({ method: "DELETE" }));
  const res = await send(
    `${REPO_PATH}/tags`,
    jsonInit("POST", message === undefined ? { tag_name: "release/v1.2", target } : { tag_name: "release/v1.2", message, target }),
  );
  expect(res.status).toBe(200);
  return jsonBody(res);
}

describe("slash-tag addressability (the wildcard siblings)", () => {
  it("POST accepts a slash tag name; GET addresses it through the wildcard arm and the declared route agrees via %2F", async () => {
    const created = await createSlashedTag(TIP1, "slashed release\n");
    expect(created.name).toBe("release/v1.2");
    // P3-11: the create response carries the annotated message (upstream
    // CreateTag answers GetTag(form.TagName) → ToTag, tag.go:225-230) —
    // and the wildcard + %2F GETs below toEqual the same body, pinning the
    // message on both GET arms in one sweep.
    expect(created.message).toBe("slashed release\n");

    // the LITERAL slash in the path — the single-segment {tag} route cannot
    // match this; the catch-all sibling does, rendering the SAME render
    const wildcard = await get(`${REPO_PATH}/tags/release/v1.2`);
    expect(wildcard.status).toBe(200);
    expect(await wildcard.json()).toEqual(created);

    // the same tag through the DECLARED route: %2F stays one segment and
    // hono's param decode resolves the identical name — byte-equal body
    const declared = await get(`${REPO_PATH}/tags/release%2Fv1.2`);
    expect(declared.status).toBe(200);
    expect(await declared.json()).toEqual(created);

    // slash-free names still match the declared route (no wildcard shadowing)
    const plain = await get(`${REPO_PATH}/tags/v1.0.0`);
    expect(plain.status).toBe(200);
    expect((await jsonBody(plain)).name).toBe("v1.0.0");
  });

  it("DELETE addresses the multi-segment name through the wildcard arm; the declared route serves the %2F form", async () => {
    await createSlashedTag(TIP2);
    const deleted = await send(`${REPO_PATH}/tags/release/v1.2`, authed({ method: "DELETE" }));
    expect(deleted.status).toBe(204);
    // gone through BOTH arms
    expect((await get(`${REPO_PATH}/tags/release/v1.2`)).status).toBe(404);
    expect((await get(`${REPO_PATH}/tags/release%2Fv1.2`)).status).toBe(404);

    // recreate and delete through the DECLARED arm — the decoded %2F name
    // hits the same ref (the two arms never disagree)
    await createSlashedTag(TIP2);
    const declaredDelete = await send(`${REPO_PATH}/tags/release%2Fv1.2`, authed({ method: "DELETE" }));
    expect(declaredDelete.status).toBe(204);
    expect((await get(`${REPO_PATH}/tags/release/v1.2`)).status).toBe(404);
  });

  it("404s an unknown multi-segment name and keeps the gates (auth + write) on the wildcard arms", async () => {
    const missing = await get(`${REPO_PATH}/tags/ghost/no-such`);
    expect(missing.status).toBe(404);
    expect((await jsonBody(missing)).message).toBe("tag doesn't exist: ghost/no-such");

    // reqToken on the wildcard DELETE (401 before any lookup)
    const anonymous = await app().fetch(new Request(`${ORIGIN}${REPO_PATH}/tags/ghost/no-such`, { method: "DELETE" }), env);
    expect(anonymous.status).toBe(401);

    // reqRepoWriter on the wildcard DELETE — gates run BEFORE the ref lookup,
    // so an unknown name 403s a non-writer (upstream's middleware order)
    const nonWriter = await send(`${REPO_PATH}/tags/ghost/no-such`, authedAs(OUTSIDER_TOKEN, { method: "DELETE" }));
    expect(nonWriter.status).toBe(403);
    expect((await jsonBody(nonWriter)).message).toBe("user should have a permission to write to the target branch");
  });

  it("resolves the tail MOUNT-agnostically: the /api/v1 mount answers identically", async () => {
    const created = await createSlashedTag(TIP1);
    // the LIVE worker mounts the api router at /api/v1 (index.ts) and hono
    // keeps c.req.path unstripped inside the mounted sub-app — the tail cut
    // must anchor on the family segment, not a fixed depth. This test
    // mirrors that composition: a parent Hono holding the family at /api/v1.
    const root = new Hono<ApiEnv>();
    const family = new OpenAPIHono<ApiEnv>();
    family.onError(giteaErrorHandler);
    registerTagRoutes(family, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
    root.route("/api/v1", family);
    const res = await root.fetch(new Request(`${ORIGIN}/api/v1${REPO_PATH}/tags/release/v1.2`, authed()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });
});

describe("annotated-tag message arms (residuals P3-11)", () => {
  /** Creates a plain annotated tag through the POST arm and returns the body. */
  async function createAnnotated(name: string, message: string, target: string): Promise<Record<string, unknown>> {
    const res = await send(`${REPO_PATH}/tags`, jsonInit("POST", { tag_name: name, message, target }));
    expect(res.status).toBe(200);
    return jsonBody(res);
  }

  it("POST echoes the annotated message; GET /tags/{name} serves the tag object's payload", async () => {
    const created = await createAnnotated("p311-annotated", "release notes\n", TIP1);
    expect(created.message).toBe("release notes\n");
    // the ref tip (id) is the TAG OBJECT oid for the annotated create
    const sha = created.id as string;
    expect(sha).not.toBe(TIP1);

    const got = await jsonBody(await get(`${REPO_PATH}/tags/p311-annotated`));
    expect(got.name).toBe("p311-annotated");
    expect(got.id).toBe(sha);
    expect(got.message).toBe("release notes\n");
    // the commit meta still peels to the target commit
    expect((got.commit as Record<string, unknown>).sha).toBe(TIP1);
  });

  it("GET /tags/{name} on a LIGHTWEIGHT tag serves the target commit's message (getTag's commit arm)", async () => {
    const got = await jsonBody(await get(`${REPO_PATH}/tags/v1.0.0`));
    expect(got.name).toBe("v1.0.0");
    // the seeded lightweight tip is commitIndex 1 ("seed: second commit");
    // upstream serves the commit's message for a commit-tipped tag
    // (repo_tag.go:213-219 / GetTagInfos' contents) — the seed builder
    // stores `${message}\n`
    expect(got.message).toBe("seed: second commit\n");
  });

  it("the list arm carries both kinds' messages", async () => {
    const body = await (await get(`${REPO_PATH}/tags`)).json<Record<string, unknown>[]>();
    const byName = new Map(body.map((tag) => [tag.name as string, tag]));
    expect(byName.get("p311-annotated")?.message).toBe("release notes\n");
    expect(byName.get("v1.0.0")?.message).toBe("seed: second commit\n");
  });

  it("GET /git/tags/{sha} renders the message + the tagger identity (ToAnnotatedTag arms)", async () => {
    const created = await createAnnotated("p311-details", "details body\n", TIP2);
    const sha = created.id as string;
    const body = await jsonBody(await get(`${REPO_PATH}/git/tags/${sha}`));
    expect(body.sha).toBe(sha);
    expect(body.tag).toBe("p311-details");
    expect(body.message).toBe("details body\n");
    // writeTagRef's tagger: the doer identity (login + its stored email)
    const tagger = body.tagger as Record<string, unknown>;
    expect(tagger.name).toBe(OWNER);
    expect(tagger.email).toBe("stub@cf-gitea.invalid");
    // ToCommitUser's date: an RFC3339 instant, freshly stamped at the write
    expect(typeof tagger.date).toBe("string");
    expect(Number.isNaN(Date.parse(tagger.date as string))).toBe(false);
    // the annotated-object body peels to the target commit
    expect((body.object as Record<string, unknown>).sha).toBe(TIP2);
  });

  it("GET /git/tags/{sha} answers the 400 on EVERY lookup failure (R15 — tag.go:113-118 maps GetAnnotatedTag/GetTagCommit errors to 400)", async () => {
    // a LIGHTWEIGHT tag's commit sha is not a tag object — upstream
    // GetAnnotatedTag errors → ctx.APIError(400) (never a 404, despite the
    // swagger's declared 404)
    const lightweight = await get(`${REPO_PATH}/git/tags/${TIP2}`);
    expect(lightweight.status).toBe(400);
    expect((await jsonBody(lightweight)).message).toBe("tag does not exist");
    // an UNKNOWN oid rides the same arm
    const unknown = await get(`${REPO_PATH}/git/tags/0123456789012345678901234567890123456789`);
    expect(unknown.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The delete arm's release coupling (v1.5.5 R2-L1 — services/release/
// release.go:376-404): the protected check runs FIRST (before `git tag -d`,
// :376-387), the `git tag -d` "not found" error is TOLERATED (:389-393) so a
// missing ref with an existing row proceeds to the events + row delete, and
// the push event's `before` is the ROW's sha1 — the PEELED commit
// (:150-151's rel.Sha1), not the raw tag-object oid.
// ---------------------------------------------------------------------------
describe("the delete arm's release coupling (release.go:376-404)", () => {
  const seedTagRow = async (repoId: string, tagName: string, sha1: string) => {
    await drizzle(env.DB).insert(releases).values({
      repoId,
      publisherId: OWNER_ID,
      tagName,
      lowerTagName: tagName.toLowerCase(),
      isTag: true,
      sha1,
      createdAt: new Date(T0 * 1000),
    });
  };

  const repoIdOf = async (): Promise<string> => {
    const row = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, SLUG)))
      .get();
    if (row === undefined) throw new Error("seed repo missing");
    return row.id;
  };

  it("a missing ref with an existing tag ROW proceeds (git tag -d's tolerated not-found): 204, the row goes, the pair (no ref, no record) still 404s", async () => {
    const repoId = await repoIdOf();
    await seedTagRow(repoId, "ghost-relay", TIP1);
    // sanity: the ref really is absent
    expect((await get(`${REPO_PATH}/tags/ghost-relay`)).status).toBe(404);

    const res = await send(`${REPO_PATH}/tags/ghost-relay`, authed({ method: "DELETE" }));
    expect(res.status).toBe(204);
    const kept = await drizzle(env.DB)
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.repoId, repoId), eq(releases.lowerTagName, "ghost-relay")))
      .all();
    expect(kept).toHaveLength(0);

    // the rowless pair — no release record AND no ref — stays the 404
    // (upstream's GetRelease miss, routers/api/v1/repo/tag.go:267-273)
    const rowless = await send(`${REPO_PATH}/tags/never-existed`, authed({ method: "DELETE" }));
    expect(rowless.status).toBe(404);
  });

  it("the protected check precedes the missing-ref arm: a protected GHOST tag with a row is the 422, not a silent 204 (release.go:376-387)", async () => {
    const repoId = await repoIdOf();
    await seedTagRow(repoId, "protected-ghost", TIP2);
    await drizzle(env.DB).insert(protectedTags).values({
      repoId,
      namePattern: "protected-*",
      allowlistUserIds: "[424242]",
      allowlistTeamIds: "[]",
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    });

    const res = await send(`${REPO_PATH}/tags/protected-ghost`, authed({ method: "DELETE" }));
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("user not allowed to delete protected tag");
    // the row survives the refusal
    const kept = await drizzle(env.DB)
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.repoId, repoId), eq(releases.lowerTagName, "protected-ghost")))
      .all();
    expect(kept).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The create arm's sender identity (v1.5.5 R2-L7 threading — services/
// release/release.go:136-143): createTag notifies with rel.Publisher —
// PushCommits' pusher AND sender, CreateRef's sender — and on the tags API
// the publisher IS the doer (CreateNewTag's `Publisher: doer`, :243-244), so the
// payload pair carries the authenticated caller. tagCreatePushPayload now
// takes the sender as a parameter (the release surfaces thread the ROW's
// publisher); this pins the tags surface's half of the threading.
// ---------------------------------------------------------------------------
describe("the create arm's sender threading (release.go:136-143, CreateNewTag :243-244)", () => {
  it("the push payload's pusher/sender and the create payload's sender are the authenticated caller (publisher == doer here)", async () => {
    const repoRow = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, SLUG)))
      .get();
    if (repoRow === undefined) throw new Error("seed repo missing");
    const hookRows = await drizzle(env.DB)
      .insert(webhooks)
      .values({
        repoId: repoRow.id,
        url: "https://hooks.invalid/tags-sender-test",
        events: JSON.stringify({ choose_events: true, branch_filter: "*", events: { push: true, create: true } }),
        isActive: true,
        type: "gitea",
        createdAt: new Date(T0 * 1000),
        updatedAt: new Date(T0 * 1000),
      })
      .returning({ id: webhooks.id })
      .all();
    const hookId = hookRows[0]!.id;

    await send(`${REPO_PATH}/tags/sender-check`, authed({ method: "DELETE" })); // idempotency pre-clear
    const created = await send(`${REPO_PATH}/tags`, jsonInit("POST", { tag_name: "sender-check", target: TIP2 }));
    expect(created.status).toBe(200);

    const deliveries = await drizzle(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.hookId, hookId))
      .all();
    const byEvent = Object.fromEntries(deliveries.map((d) => [d.eventType, JSON.parse(d.payloadContent) as Record<string, unknown>]));
    const push = byEvent.push as { pusher: { login: string }; sender: { login: string } } | undefined;
    expect(push?.pusher).toMatchObject({ login: OWNER }); // PushCommits' pusher — rel.Publisher
    expect(push?.sender).toMatchObject({ login: OWNER }); // PushCommits' sender — the same identity
    const create = byEvent.create as { sender: { login: string } } | undefined;
    expect(create?.sender).toMatchObject({ login: OWNER }); // CreateRef's sender — rel.Publisher

    // cleanup: the tag ref and this test's hook rows (the storage persists per file)
    await send(`${REPO_PATH}/tags/sender-check`, authed({ method: "DELETE" }));
    await drizzle(env.DB).delete(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId));
    await drizzle(env.DB).delete(webhooks).where(eq(webhooks.id, hookId));
  });
});
