/**
 * The six wiki ops of the remaining-API inventory's batch 10
 * (`wave-api-wiki`, specs/wiki.md) on REAL engine content: the repo seeds
 * through the landed git-http receive flow (ensureSeededRepo — real pack
 * push), and every wiki write lands in the sibling `owner/slug.wiki` ENGINE
 * CELL through putApiObjects + commitApiChange (the batch's lazy
 * provisioning), so the suite exercises a true
 * create → read → edit(rename) → revisions → delete cycle.
 *
 * The routes mount LOCALLY with the real auth middlewares (the deferred
 * router.ts one-liner's exact seam), asserting:
 *   - the storage contract: the first create provisions `wikiowner/<slug>.wiki`
 *     (root commit, HEAD seated), the repo cell stays untouched, commit
 *     messages carry upstream's exact templates (`Add "Home"` /
 *     `Update "Getting-Started"` / `Delete page "…"`);
 *   - the codec: spaces→dashes, the `.-` dash-marker round trip, `.md`
 *     passthrough, QueryEscape parity, `unnamed` fallback, `%2F` request form;
 *   - the contract arms: create-existing 400 (ErrWikiAlreadyExist text),
 *     reserved title 400, invalid base64 400 (Go CorruptInputError text),
 *     missing title 422 (the Go-bind runtime-only class), DELETE missing 404,
 *     PATCH upsert on an empty wiki;
 *   - the gates: reqToken 401, reqRepoWriter's exact 403, mustNotBeArchived
 *     423 ahead of the write grant (reads still 200 on archived), invisible
 *     = missing 404, empty-wiki reads = empty list / 404 (never an error);
 *   - the contract declaration: operationId + response-set subset per arm
 *     against the frozen contract JSON (the per-arm check:api verification,
 *     run in-test because the router.ts registration is the orchestrator's).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";

import { ensureSeededRepo } from "../../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, repoSettings, users, webhookDeliveries, webhooks } from "../../db/schema";
import {
  createOptionalTokenAuthMiddleware,
  createTokenAuthMiddleware,
  STUB_USER,
  type AuthResolver,
} from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerWikiRoutes } from "./wiki";
import { contract } from "../../compat/contract/frozen-contract";
import {
  gitPathToWebPath,
  goQuote,
  pathJoinRelX,
  userTitleToWebPath,
  webPathFromRequest,
  webPathToGitPath,
  webPathToUserTitle,
} from "../../services/wiki";

// wave-129 full-run contention budget: this file's beforeAll seeding (the
// receive-flow wiki repo) measured a 4.59s hook share of the 30s default IN a
// green 8-worker full run (its heaviest test measured 3.09s; the suite's
// 260-isolate spawn storm spikes closures up to ~12x their solo time).
// File-local 90s budgets; vitest.config.ts keeps 30s for every other file.
// Membership: the measured >=4s in-run closure/hook set (full-suite junit
// run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ORIGIN = "https://wikisuite.test";
const TOKEN = "wiki-suite-owner";
const OUTSIDER_TOKEN = "wiki-suite-outsider";
const OWNER = "wikiowner";
const MAIN = "wmain";
const EMPTY = "wempty";
const ARCH = "warch";
const PRIV = "wpriv";
const OFF = "woff";
const OFFARCH = "woffarch";
const MAIN_PATH = `/repos/${OWNER}/${MAIN}`;
const EMPTY_PATH = `/repos/${OWNER}/${EMPTY}`;
const ARCH_PATH = `/repos/${OWNER}/${ARCH}`;
const PRIV_PATH = `/repos/${OWNER}/${PRIV}`;
const OFF_PATH = `/repos/${OWNER}/${OFF}`;
const OFFARCH_PATH = `/repos/${OWNER}/${OFFARCH}`;

let OWNER_ID = 1;

/** The repo_settings upsert behind PATCH /repos/{owner}/{repo} — the unit
 *  flag's D1 store. loadRepoSettings renders the ENABLED default for a
 *  missing row, so the disabled flip must land a row, not a no-op UPDATE. */
async function setWikiUnit(slug: string, enabled: boolean): Promise<void> {
  const repo = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, slug)).get();
  if (repo === undefined) throw new Error(`wiki-unit flip: ${slug} row missing`);
  await drizzle(env.DB)
    .insert(repoSettings)
    .values({ repoId: repo.id, hasWiki: enabled })
    .onConflictDoUpdate({ target: repoSettings.repoId, set: { hasWiki: enabled, updatedAt: new Date() } });
}

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  const seed = { message: "seed: initial layout", time: 1_760_000_000, files: [{ path: "README.md", content: "# seed\n" }] };
  await ensureSeededRepo({ owner: OWNER, slug: MAIN, commits: [seed] });
  await ensureSeededRepo({ owner: OWNER, slug: EMPTY, commits: [seed] });
  await ensureSeededRepo({ owner: OWNER, slug: ARCH, commits: [seed] });
  await ensureSeededRepo({ owner: OWNER, slug: PRIV, commits: [seed] });
  await ensureSeededRepo({ owner: OWNER, slug: OFF, commits: [seed] });
  await ensureSeededRepo({ owner: OWNER, slug: OFFARCH, commits: [seed] });
  // the D1 flips for the gate arms (D1 is the metadata source of truth)
  await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.slug, ARCH)).run();
  await drizzle(env.DB).update(repositories).set({ visibility: "private" }).where(eq(repositories.slug, PRIV)).run();
  await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.slug, OFFARCH)).run();
  await setWikiUnit(OFF, false);
  await setWikiUnit(OFFARCH, false);
  const owner = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (owner === undefined) throw new Error("seed owner missing");
  OWNER_ID = owner.id;
});

function identity(): User {
  return { ...STUB_USER, id: OWNER_ID, login: OWNER, full_name: OWNER, created: new Date(1_760_000_000 * 1000).toISOString() };
}

function outsiderIdentity(): User {
  return { ...STUB_USER, id: 424242, login: "outsider", full_name: "outsider", created: new Date(1_760_000_000 * 1000).toISOString() };
}

const resolver: AuthResolver = {
  resolveToken: (token: string) =>
    Promise.resolve(token === TOKEN ? identity() : token === OUTSIDER_TOKEN ? outsiderIdentity() : null),
};

/** Local mount — the deferred router.ts one-liner's exact seam. */
function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  registerWikiRoutes(a, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return a;
}

const authed = (init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${TOKEN}` },
});

const jsonInit = (method: string, body: unknown, token = TOKEN): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json", Authorization: `token ${token}` },
  body: JSON.stringify(body),
});

const get = async (path: string): Promise<Response> => app().fetch(new Request(`${ORIGIN}${path}`), env);
const send = async (path: string, init: RequestInit): Promise<Response> => app().fetch(new Request(`${ORIGIN}${path}`, init), env);

/** The parsed body of an in-process response, typed at the call site. */
async function jsonBody<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

/** Strict-StdEncoding base64 of UTF-8 bytes (the body's content_base64). */
function utf8B64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

// ---------------------------------------------------------------------------
// The WebPath codec (services/wiki — the wiki_path.go port, pure functions)
// ---------------------------------------------------------------------------

describe("wiki WebPath codec (wiki_path.go port)", () => {
  it("maps plain names to <name>.md and back", () => {
    expect(webPathToGitPath("Home")).toBe("Home.md");
    expect(gitPathToWebPath("Home.md")).toBe("Home");
    expect(gitPathToWebPath("NotAPage.txt")).toBeNull();
  });

  it("converts user titles: space→dash, dash→dash-marker", () => {
    expect(userTitleToWebPath("", "Setup Guide")).toBe("Setup-Guide");
    expect(userTitleToWebPath("", "A-B")).toBe("A-B.-");
    expect(webPathToGitPath("A-B.-")).toBe("A-B.-.md");
    expect(gitPathToWebPath("A-B.-.md")).toBe("A-B.-");
    expect(webPathToUserTitle("A-B.-").display).toBe("A-B");
    expect(webPathToUserTitle("Setup-Guide").display).toBe("Setup Guide");
  });

  it("passes .md-suffixed WebPaths through raw (the escape hatch)", () => {
    expect(webPathToGitPath("raw-file.md")).toBe("raw-file.md");
  });

  it("keeps Go QueryEscape parity (%25, + for space, !'()* escaped)", () => {
    expect(webPathToGitPath("100%25-Free")).toBe("100%25-Free.md");
    expect(userTitleToWebPath("", "100% Free")).toBe("100%25-Free");
    expect(userTitleToWebPath("", "bang!")).toBe("bang%21");
  });

  it("falls back to unnamed and cleans requests", () => {
    expect(userTitleToWebPath("", "   ")).toBe("unnamed");
    expect(webPathFromRequest("docs/Home")).toBe("docs%2FHome");
    expect(pathJoinRelX("a", "../b")).toBe("a/b");
    expect(goQuote('He said "hi"\n')).toBe('"He said \\"hi\\"\\n"');
  });

  it("answers the empty join with the empty path (upstream's empty-input arm)", () => {
    // gitea/modules/util/path.go: PathJoinRelX("") skips the empty element,
    // PathJoinRel then path.Join()s nothing → `case "": return ""` — the bare
    // `/wiki` tail must codec to "" (the routers' `len(pageName) == 0` arm),
    // never ".". Only an all-dots join cleans to "/" and answers ".".
    expect(pathJoinRelX("")).toBe("");
    expect(pathJoinRelX("", "")).toBe("");
    expect(webPathFromRequest("")).toBe("");
    expect(pathJoinRelX(".")).toBe(".");
    expect(pathJoinRelX("..")).toBe(".");
  });
});

// ---------------------------------------------------------------------------
// Contract declaration — the per-arm check:api verification (run here because
// the router.ts registration is the orchestrator's)
// ---------------------------------------------------------------------------

describe("contract declaration", () => {
  const ARMS = [
    ["get", "/repos/{owner}/{repo}/wiki/pages"],
    ["get", "/repos/{owner}/{repo}/wiki/page/{pageName}"],
    ["get", "/repos/{owner}/{repo}/wiki/revisions/{pageName}"],
    ["post", "/repos/{owner}/{repo}/wiki/new"],
    ["patch", "/repos/{owner}/{repo}/wiki/page/{pageName}"],
    ["delete", "/repos/{owner}/{repo}/wiki/page/{pageName}"],
  ] as const;

  it("declares every arm with the contract's operationId and a response subset", () => {
    const doc = app().getOpenAPIDocument({ openapi: "3.0.3", info: { title: "Gitea API", version: "test" } });
    for (const [method, path] of ARMS) {
      const declared = doc.paths?.[path]?.[method];
      expect(declared, `${method.toUpperCase()} ${path}`).toBeDefined();
      const expected = contract.paths[path]?.[method];
      expect(expected, `contract ${method.toUpperCase()} ${path}`).toBeDefined();
      expect(declared?.operationId).toBe(expected?.operationId);
      const contractCodes = Object.keys(expected?.responses ?? {});
      for (const code of Object.keys(declared?.responses ?? {})) {
        expect(contractCodes, `${method.toUpperCase()} ${path} response ${code}`).toContain(code);
      }
    }
  });

  it("declares exactly the four contract wiki paths, six operations", () => {
    const doc = app().getOpenAPIDocument({ openapi: "3.0.3", info: { title: "Gitea API", version: "test" } });
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(
      [
        "/repos/{owner}/{repo}/wiki/new",
        "/repos/{owner}/{repo}/wiki/page/{pageName}",
        "/repos/{owner}/{repo}/wiki/pages",
        "/repos/{owner}/{repo}/wiki/revisions/{pageName}",
      ].sort(),
    );
    const methods = Object.values(doc.paths ?? {}).flatMap((item) => Object.keys(item));
    expect(methods).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Empty-wiki reads — never an error (specs/wiki.md §3)
// ---------------------------------------------------------------------------

describe("empty wiki (no cell provisioned)", () => {
  it("lists an empty array with the totals header (repoGetWikiPages)", async () => {
    const res = await get(`${EMPTY_PATH}/wiki/pages`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("0");
    expect(res.headers.get("Link")).toBeNull();
    expect(await res.json()).toEqual([]);
  });

  it("404s a page read (repoGetWikiPage)", async () => {
    const res = await get(`${EMPTY_PATH}/wiki/page/Home`);
    expect(res.status).toBe(404);
  });

  it("404s revisions (repoGetWikiPageRevisions)", async () => {
    const res = await get(`${EMPTY_PATH}/wiki/revisions/Home`);
    expect(res.status).toBe(404);
  });

  it("404s a DELETE of a missing page (repoDeleteWikiPage)", async () => {
    const res = await send(`${EMPTY_PATH}/wiki/page/Ghost`, authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
  });

  it("PATCH upserts a page on the empty wiki (repoEditWikiPage)", async () => {
    const res = await send(`${EMPTY_PATH}/wiki/page/Intro`, jsonInit("PATCH", { content_base64: utf8B64("intro v1\n") }));
    expect(res.status).toBe(200);
    const page = await jsonBody<Record<string, unknown>>(res);
    expect(page.title).toBe("Intro");
    expect(page.commit_count).toBe(1);
    expect(page.content_base64).toBe(utf8B64("intro v1\n"));
    const reread = await get(`${EMPTY_PATH}/wiki/page/Intro`);
    expect(reread.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The full cycle on the main repo — create → read → edit(rename) → revisions
// → delete, against the real sibling cell
// ---------------------------------------------------------------------------

describe("wiki lifecycle (repoCreateWikiPage → … → repoDeleteWikiPage)", () => {
  it("runs the full cycle with upstream's message templates and shapes", async () => {
    // --- create Home (provisions the sibling cell with a root commit)
    const create = await send(`${MAIN_PATH}/wiki/new`, jsonInit("POST", { title: "Home", content_base64: utf8B64("# Home\n") }));
    expect(create.status).toBe(201);
    const home = await jsonBody<Record<string, unknown>>(create);
    expect(home.title).toBe("Home");
    expect(home.sub_url).toBe("Home");
    expect(home.html_url).toBe(`${ORIGIN}/${OWNER}/${MAIN}/wiki/Home`);
    expect(home.content_base64).toBe(utf8B64("# Home\n"));
    expect(home.commit_count).toBe(1);
    expect(home.sidebar).toBe("");
    expect(home.footer).toBe("");
    const homeLast = home.last_commit as Record<string, unknown>;
    expect((homeLast.author as Record<string, unknown>).date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(homeLast.message).toBe('Add "Home"\n'); // git stores the trailing newline (MessageUTF8 pass-through)

    // --- the storage convention: sibling cell provisioned, repo cell untouched
    const wikiRefs = await env.REPO.getByName(`${OWNER}/${MAIN}.wiki`).listRefs();
    const branchRef = wikiRefs.refs.find((ref) => ref.name === "refs/heads/main");
    expect(branchRef).toBeDefined();
    expect(wikiRefs.head).toBe("refs/heads/main");
    const rootCommit = await env.REPO.getByName(`${OWNER}/${MAIN}.wiki`).readCommit(branchRef?.target);
    expect(rootCommit?.parents).toEqual([]); // first write commits without parents
    const repoRefs = await env.REPO.getByName(`${OWNER}/${MAIN}`).listRefs();
    expect(repoRefs.refs.find((ref) => ref.name === "refs/heads/main")?.target).not.toBe(branchRef?.target);

    // --- the list: one entry, totals header, no Link for a single page
    const list1 = await get(`${MAIN_PATH}/wiki/pages`);
    expect(list1.status).toBe(200);
    expect(list1.headers.get("X-Total-Count")).toBe("1");
    expect(list1.headers.get("Link")).toBeNull();
    const pages1 = await jsonBody<Array<Record<string, unknown>>>(list1);
    expect(pages1).toHaveLength(1);
    expect(pages1[0]?.title).toBe("Home");
    expect(pages1[0]?.sub_url).toBe("Home");

    // --- a second page whose title needs the codec (space → dash)
    const create2 = await send(
      `${MAIN_PATH}/wiki/new`,
      jsonInit("POST", { title: "Setup Guide", content_base64: utf8B64("setup steps\n") }),
    );
    expect(create2.status).toBe(201);
    const setup = await jsonBody<Record<string, unknown>>(create2);
    expect(setup.title).toBe("Setup Guide");
    expect(setup.sub_url).toBe("Setup-Guide");
    expect(setup.commit_count).toBe(1);

    // --- read it back through the coded WebPath
    const readSetup = await get(`${MAIN_PATH}/wiki/page/Setup-Guide`);
    expect(readSetup.status).toBe(200);
    expect((await jsonBody<Record<string, unknown>>(readSetup)).content_base64).toBe(utf8B64("setup steps\n"));

    // --- pagination: the full list has no Link (single page at the 30 default;
    // upstream clamps limit<=1 → DefaultPagingNum, wiki.go router)
    const list2 = await get(`${MAIN_PATH}/wiki/pages`);
    expect(list2.status).toBe(200);
    expect(list2.headers.get("X-Total-Count")).toBe("2");
    expect(list2.headers.get("Link")).toBeNull();
    expect(await jsonBody<unknown[]>(list2)).toHaveLength(2);

    // --- a third page, then real pagination (?limit=2 → next/last, then prev/first)
    const create3 = await send(
      `${MAIN_PATH}/wiki/new`,
      jsonInit("POST", { title: "Roadmap", content_base64: utf8B64("roadmap\n") }),
    );
    expect(create3.status).toBe(201);
    const page1 = await get(`${MAIN_PATH}/wiki/pages?page=1&limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.headers.get("X-Total-Count")).toBe("3");
    expect(page1.headers.get("Link")).toContain('rel="next"');
    expect(page1.headers.get("Link")).toContain('rel="last"');
    expect(await jsonBody<unknown[]>(page1)).toHaveLength(2);
    const page2 = await get(`${MAIN_PATH}/wiki/pages?page=2&limit=2`);
    // git tree byte order: Home.md < Roadmap.md < Setup-Guide.md
    expect((await jsonBody<Array<Record<string, unknown>>>(page2))[0]?.sub_url).toBe("Setup-Guide");
    expect(page2.headers.get("Link")).toContain('rel="prev"');
    expect(page2.headers.get("Link")).toContain('rel="first"');

    // --- revisions of Home before the rename (message template verbatim)
    const homeRevisions = await get(`${MAIN_PATH}/wiki/revisions/Home`);
    expect(homeRevisions.status).toBe(200);
    expect(homeRevisions.headers.get("X-Total-Count")).toBe("1");
    const homeCommits = await jsonBody<{ commits: Array<Record<string, unknown>>; count: number }>(homeRevisions);
    expect(homeCommits.count).toBe(1);
    expect(homeCommits.commits[0]?.message).toBe('Add "Home"\n');

    // --- edit + rename (default message `Update %q(newWikiName)`)
    const edit = await send(
      `${MAIN_PATH}/wiki/page/Home`,
      jsonInit("PATCH", { title: "Getting Started", content_base64: utf8B64("# Getting Started\n") }),
    );
    expect(edit.status).toBe(200);
    const renamed = await jsonBody<Record<string, unknown>>(edit);
    expect(renamed.title).toBe("Getting Started");
    expect(renamed.sub_url).toBe("Getting-Started");
    expect(renamed.content_base64).toBe(utf8B64("# Getting Started\n"));
    // only the rename commit touches the new path (no --follow, like upstream)
    expect(renamed.commit_count).toBe(1);

    // --- the old name is gone; the renamed page's revisions carry the rename
    expect((await get(`${MAIN_PATH}/wiki/page/Home`)).status).toBe(404);
    const revisions = await get(`${MAIN_PATH}/wiki/revisions/Getting-Started`);
    expect(revisions.status).toBe(200);
    expect(revisions.headers.get("X-Total-Count")).toBe("1");
    const commitList = await jsonBody<{ commits: Array<Record<string, unknown>>; count: number }>(revisions);
    expect(commitList.count).toBe(1);
    expect(commitList.commits).toHaveLength(1);
    expect(commitList.commits[0]?.message).toBe('Update "Getting-Started"\n');
    expect((commitList.commits[0]?.commiter as Record<string, unknown>).name).toBe(OWNER);

    // --- revisions pagination (page size 50 upstream; page=2 → empty)
    const rev2 = await get(`${MAIN_PATH}/wiki/revisions/Getting-Started?page=2`);
    const rev2Body = await jsonBody<{ commits: unknown[]; count: number }>(rev2);
    expect(rev2Body.commits).toHaveLength(0);
    expect(rev2Body.count).toBe(1);

    // --- delete → 204 → 404 → the list shrinks
    const del = await send(`${MAIN_PATH}/wiki/page/Getting-Started`, authed({ method: "DELETE" }));
    expect(del.status).toBe(204);
    expect((await get(`${MAIN_PATH}/wiki/page/Getting-Started`)).status).toBe(404);
    const delAgain = await send(`${MAIN_PATH}/wiki/page/Getting-Started`, authed({ method: "DELETE" }));
    expect(delAgain.status).toBe(404);
    const list3 = await get(`${MAIN_PATH}/wiki/pages`);
    expect(list3.headers.get("X-Total-Count")).toBe("2");
    expect((await jsonBody<Array<Record<string, unknown>>>(list3)).map((entry) => entry.sub_url)).toEqual([
      "Roadmap",
      "Setup-Guide",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Contract arms + gates
// ---------------------------------------------------------------------------

describe("wiki gates and error arms", () => {
  it("400s a create of an existing page with upstream's ErrWikiAlreadyExist text", async () => {
    const first = await send(`${MAIN_PATH}/wiki/new`, jsonInit("POST", { title: "Dup", content_base64: utf8B64("one\n") }));
    expect(first.status).toBe(201);
    const second = await send(`${MAIN_PATH}/wiki/new`, jsonInit("POST", { title: "Dup", content_base64: utf8B64("two\n") }));
    expect(second.status).toBe(400);
    expect((await jsonBody<Record<string, unknown>>(second)).message).toBe("wiki page already exists [title: Dup.md]");
  });

  it("400s a reserved title with upstream's ErrWikiReservedName text", async () => {
    const res = await send(`${MAIN_PATH}/wiki/new`, jsonInit("POST", { title: "raw", content_base64: "" }));
    expect(res.status).toBe(400);
    expect((await jsonBody<Record<string, unknown>>(res)).message).toBe("wiki title is reserved: raw");
  });

  it("400s invalid base64 with Go's CorruptInputError text", async () => {
    const res = await send(`${MAIN_PATH}/wiki/new`, jsonInit("POST", { title: "B64", content_base64: "!!not-base64!!" }));
    expect(res.status).toBe(400);
    expect((await jsonBody<Record<string, unknown>>(res)).message).toBe("illegal base64 data at input byte 0");
  });

  it("422s a missing title (the Go bind Required class)", async () => {
    const res = await send(`${MAIN_PATH}/wiki/new`, jsonInit("POST", { content_base64: utf8B64("x") }));
    expect(res.status).toBe(422);
  });

  it("401s anonymous writes", async () => {
    const res = await send(`${MAIN_PATH}/wiki/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Anon", content_base64: "" }),
    });
    expect(res.status).toBe(401);
  });

  it("403s a non-collaborator write with upstream's reqRepoWriter message", async () => {
    const res = await send(`${MAIN_PATH}/wiki/new`, jsonInit("POST", { title: "Nope", content_base64: "" }, OUTSIDER_TOKEN));
    expect(res.status).toBe(403);
    expect((await jsonBody<Record<string, unknown>>(res)).message).toBe(
      "user should have a permission to write to the target branch",
    );
  });

  it("423s archived-repo writes before the write grant; reads still 200", async () => {
    const write = await send(`${ARCH_PATH}/wiki/new`, jsonInit("POST", { title: "Arch", content_base64: "" }));
    expect(write.status).toBe(423);
    const outsider = await send(`${ARCH_PATH}/wiki/new`, jsonInit("POST", { title: "Arch", content_base64: "" }, OUTSIDER_TOKEN));
    expect(outsider.status).toBe(423);
    const read = await get(`${ARCH_PATH}/wiki/pages`);
    expect(read.status).toBe(200);
  });

  it("404s invisible (private) repos on reads and writes — invisible = missing", async () => {
    expect((await get(`${PRIV_PATH}/wiki/pages`)).status).toBe(404);
    const write = await send(`${PRIV_PATH}/wiki/new`, jsonInit("POST", { title: "Priv", content_base64: "" }, OUTSIDER_TOKEN));
    expect(write.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Webhook emissions (services/wiki.ts — the upstream WikiPayload triple,
// notifier.go:534-562): the three write triggers each fire exactly once
// through the shared service seam, upstream-shaped; reads and failed writes
// stay silent. Deliveries are asserted over the webhook_deliveries D1 rows
// (the delivery log IS the source of truth, SPEC-0005 §3.6).
// ---------------------------------------------------------------------------

describe("wiki webhook emissions (the upstream WikiPayload triple)", () => {
  const HOOKS = "whooks";
  const HOOKS_PATH = `/repos/${OWNER}/${HOOKS}`;
  let REPO_ID = "";
  let wikiHookId = 0;
  let pushHookId = 0;
  let everythingHookId = 0;

  beforeAll(async () => {
    await ensureSeededRepo({
      owner: OWNER,
      slug: HOOKS,
      commits: [{ message: "seed: hooks repo", time: 1_760_000_000, files: [{ path: "README.md", content: "# seed\n" }] }],
    });
    const repoRow = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, HOOKS)))
      .get();
    if (repoRow === undefined) throw new Error("hooks repo row missing");
    REPO_ID = repoRow.id;
    wikiHookId = await seedHook(REPO_ID, { choose_events: true, branch_filter: "*", events: { wiki: true } });
    pushHookId = await seedHook(REPO_ID, { choose_events: true, branch_filter: "*", events: { push: true } });
    everythingHookId = await seedHook(REPO_ID, { send_everything: true, branch_filter: "*" });
  });

  /** Active webhook with the given subscription config — the fan-out matcher target. */
  async function seedHook(repoId: string, config: Record<string, unknown>): Promise<number> {
    const rows = await drizzle(env.DB)
      .insert(webhooks)
      .values({
        repoId,
        url: "https://hooks.invalid/wiki-emissions-test",
        events: JSON.stringify(config),
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

  const deliveriesFor = async (hookId: number): Promise<Array<(typeof webhookDeliveries.$inferSelect | undefined)>> =>
    drizzle(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.hookId, hookId))
      .orderBy(asc(webhookDeliveries.id))
      .all();

  /** The parsed payload of delivery N, typed loose at the call sites. */
  const payloadOf = async (hookId: number, index: number): Promise<Record<string, unknown>> => {
    const rows = await deliveriesFor(hookId);
    const row = rows[index];
    if (row === undefined) throw new Error(`delivery ${index} missing for hook ${hookId}`);
    return JSON.parse(row.payloadContent) as Record<string, unknown>;
  };

  it("runs the write triple upstream-shaped — exactly once per trigger, silent reads, silent failed writes", async () => {
    // --- create with an explicit message: comment = the message verbatim
    const create = await send(
      `${HOOKS_PATH}/wiki/new`,
      jsonInit("POST", { title: "Hooked", content_base64: utf8B64("# hooked\n"), message: "seed msg" }),
    );
    expect(create.status).toBe(201);
    const deliveries = await deliveriesFor(wikiHookId);
    expect(deliveries).toHaveLength(1);
    const createdRow = deliveries[0]!;
    expect(createdRow.eventType).toBe("wiki");
    expect(createdRow.eventGroup).toBe("wiki"); // the bare type — upstream HookEventWiki.Event()
    // NOTE: no `state` assertion — the service seam enqueues through the real
    // WEBHOOK_DELIVERY binding, and index.ts's queue consumer is LIVE in the
    // vitest workerd (webhooks-push.test.ts's settleDeliveries note): the row
    // may already have left `pending` by the time this assertion runs. The
    // emission contract is the row's event/payload columns; state semantics
    // belong to the consumer's own suite.
    expect(createdRow.repoId).toBe(REPO_ID);
    // §2.7 serialization: 2-space JSON, action first (upstream struct order).
    expect(createdRow.payloadContent).toContain('\n  "action": "created"');
    const created = await payloadOf(wikiHookId, 0);
    // ALL five WikiPayload fields (Go marshals zero values — no omitempty).
    expect(Object.keys(created).sort()).toEqual(["action", "comment", "page", "repository", "sender"]);
    expect(created.action).toBe("created");
    expect(created.page).toBe("Hooked");
    expect(created.comment).toBe("seed msg");
    const sender = created.sender as Record<string, unknown>;
    expect(sender.login).toBe(OWNER);
    expect(sender.id).toBe(OWNER_ID);
    const repository = created.repository as Record<string, unknown>;
    expect(repository.full_name).toBe(`${OWNER}/${HOOKS}`);
    expect(repository.html_url).toBe(`${ORIGIN}/${OWNER}/${HOOKS}`);

    // --- create without a message: comment is the ROUTER-DEFAULTED template
    // (both upstream routers fill form.Message before notify — v1
    // wiki.go:64-66 `fmt.Sprintf("Add %q", form.Title)`, web wiki.go:674-676)
    const create2 = await send(`${HOOKS_PATH}/wiki/new`, jsonInit("POST", { title: "Second Page", content_base64: utf8B64("two\n") }));
    expect(create2.status).toBe(201);
    expect(await deliveriesFor(wikiHookId)).toHaveLength(2);
    const second = await payloadOf(wikiHookId, 1);
    expect(second.action).toBe("created");
    expect(second.page).toBe("Second-Page");
    expect(second.comment).toBe('Add "Second Page"');

    // --- reads/metadata never emit
    expect((await get(`${HOOKS_PATH}/wiki/pages`)).status).toBe(200);
    expect((await get(`${HOOKS_PATH}/wiki/page/Hooked`)).status).toBe(200);
    expect((await get(`${HOOKS_PATH}/wiki/revisions/Hooked`)).status).toBe(200);
    expect(await deliveriesFor(wikiHookId)).toHaveLength(2);

    // --- edit + rename with an explicit message: page = the NEW WebPath
    // (upstream wiki.go:157 notifies `string(newWikiName)`)
    const edit = await send(
      `${HOOKS_PATH}/wiki/page/Hooked`,
      jsonInit("PATCH", { title: "Hooked Renamed", content_base64: utf8B64("# renamed\n"), message: "renamed msg" }),
    );
    expect(edit.status).toBe(200);
    expect(await deliveriesFor(wikiHookId)).toHaveLength(3);
    const edited = await payloadOf(wikiHookId, 2);
    expect(edited.action).toBe("edited");
    expect(edited.page).toBe("Hooked-Renamed");
    expect(edited.comment).toBe("renamed msg");

    // --- in-place edit without a message: the Update %q default
    const edit2 = await send(`${HOOKS_PATH}/wiki/page/Hooked-Renamed`, jsonInit("PATCH", { content_base64: utf8B64("# again\n") }));
    expect(edit2.status).toBe(200);
    expect(await deliveriesFor(wikiHookId)).toHaveLength(4);
    const edited2 = await payloadOf(wikiHookId, 3);
    expect(edited2.action).toBe("edited");
    expect(edited2.page).toBe("Hooked-Renamed");
    expect(edited2.comment).toBe('Update "Hooked-Renamed"');

    // --- delete: the payload carries the Go-zero comment (upstream's
    // DeleteWikiPage takes no comment arg, notifier.go:560-562)
    const del = await send(`${HOOKS_PATH}/wiki/page/Hooked-Renamed`, authed({ method: "DELETE" }));
    expect(del.status).toBe(204);
    expect(await deliveriesFor(wikiHookId)).toHaveLength(5);
    const deleted = await payloadOf(wikiHookId, 4);
    expect(deleted.action).toBe("deleted");
    expect(deleted.page).toBe("Hooked-Renamed");
    expect(deleted.comment).toBe("");

    // --- failed writes stay silent (400 duplicate, 404 ghost)
    const dup = await send(`${HOOKS_PATH}/wiki/new`, jsonInit("POST", { title: "Second Page", content_base64: utf8B64("x\n") }));
    expect(dup.status).toBe(400);
    const ghost = await send(`${HOOKS_PATH}/wiki/page/Ghost`, authed({ method: "DELETE" }));
    expect(ghost.status).toBe(404);
    expect(await deliveriesFor(wikiHookId)).toHaveLength(5);

    // --- subscription scoping: the push-only hook never hears wiki;
    // send_everything hears all five
    expect(await deliveriesFor(pushHookId)).toHaveLength(0);
    expect(await deliveriesFor(everythingHookId)).toHaveLength(5);
    const everyFirst = await payloadOf(everythingHookId, 0);
    expect(everyFirst.action).toBe("created");
    expect(everyFirst.page).toBe("Hooked");
  });
});

// ---------------------------------------------------------------------------
// The disabled-wiki family — the group-close mustEnableUnit(unit.TypeWiki)
// (api.go:1389-1397, guard :746-752) mounted over repo_settings.hasWiki. A
// disabled wiki 404s the subtree for EVERY caller (the enabled-units-only
// permission map — owner and admin included), and the 404 lands BEFORE the
// write arms' own gates: upstream's chi group middleware wraps reqToken's
// 401, mustNotBeArchived's 423 and reqRepoWriter's 403. The other describes
// in this file all run with has_wiki on — that IS the "enabled unchanged"
// pin; the arm below re-asserts one enabled read after the flips.
// ---------------------------------------------------------------------------

describe("disabled wiki (mustEnableUnit(unit.TypeWiki) over repo_settings.hasWiki)", () => {
  it("404s every read, anonymous and owner alike (the unit is unreadable to everyone)", async () => {
    for (const path of [`${OFF_PATH}/wiki/pages`, `${OFF_PATH}/wiki/page/Home`, `${OFF_PATH}/wiki/revisions/Home`]) {
      expect((await get(path)).status).toBe(404);
      expect((await send(path, authed())).status).toBe(404);
    }
  });

  it("renders upstream's APIErrorNotFound body (services/context/api.go:137-142)", async () => {
    const res = await get(`${OFF_PATH}/wiki/pages`);
    expect(res.status).toBe(404);
    const body = await jsonBody<Record<string, string>>(res);
    expect(body.message).toBe("not found");
    expect(body.url).toBe(`${ORIGIN}/api/swagger`);
  });

  it("404s the writes before the auth and grant gates (the group-close wraps reqToken/reqRepoWriter)", async () => {
    // anonymous: mustEnableUnit precedes reqToken — 404, never 401
    const anon = await send(`${OFF_PATH}/wiki/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Off", content_base64: "" }),
    });
    expect(anon.status).toBe(404);
    // reqRepoWriter's 403 never surfaces either (an outsider is wrapped too)
    const outsider = await send(
      `${OFF_PATH}/wiki/new`,
      jsonInit("POST", { title: "Off", content_base64: "" }, OUTSIDER_TOKEN),
    );
    expect(outsider.status).toBe(404);
    // the owner — who passes every gate on an enabled repo — 404s on all three arms
    expect((await send(`${OFF_PATH}/wiki/new`, jsonInit("POST", { title: "Off", content_base64: "" }))).status).toBe(404);
    expect((await send(`${OFF_PATH}/wiki/page/Any`, jsonInit("PATCH", { content_base64: "" }))).status).toBe(404);
    expect((await send(`${OFF_PATH}/wiki/page/Any`, authed({ method: "DELETE" }))).status).toBe(404);
  });

  it("404s an archived + wiki-disabled write before mustNotBeArchived (the group-close precedes the 423)", async () => {
    const res = await send(`${OFFARCH_PATH}/wiki/new`, jsonInit("POST", { title: "Off", content_base64: "" }));
    expect(res.status).toBe(404);
  });

  it("leaves an enabled sibling untouched after the flips (no cross-repo bleed)", async () => {
    const res = await get(`${MAIN_PATH}/wiki/pages`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).not.toBe("0");
  });
});
