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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users } from "../../db/schema";
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
