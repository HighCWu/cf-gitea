/**
 * The fork-to-edit fold's ROUTE-level round trip (census gap #13 — the
 * ui/index.ts fold over pages/repo-editor-fork.tsx's seams; the module
 * seams' own tests live in repo-editor-fork.test.tsx). Every test drives
 * the mounted uiRouter the way the browser would:
 *
 *   - the route claim: parseUiRoute pins the `/_fork/{branch}` shape (the
 *     underscore literal, POST-only registration — the GET misses to the
 *     plain 404);
 *   - the reader without write → the PROMPT render (the gate's non-writer
 *     split — fileEditorGate's forkArm);
 *   - the POST → the fork created + the 303 reload (the return_uri), the
 *     double-POST race answering the reload arm, the forged return_uri
 *     falling back to the editor root, the anonymous 303, the archived 404,
 *     the unresolvable-branch 404;
 *   - the edit RE-TARGETED: with the fork present the same editor GET
 *     renders the WillSubmitToFork overlay (the fork's editor route +
 *     `from_base_branch`, the blue banner, the fork's branch select — the
 *     settling-fork strand renders the default branch alone), and the
 *     SETTLED fork lists its live branches;
 *   - the writer and anonymous arms unchanged (the base action, no banner).
 *
 * Fixtures mirror repo-editor-fork.test.tsx's (the SAME cells — separate
 * workerd instances per file): alice/edork the base, edforksam/edork the
 * SETTLED fork, edforkpat the fork-less reader. Per-test storage rollback
 * makes the create POST's fork ephemeral — the no-fork arms stay
 * order-independent.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { uiEnv } from "../__tests__/harness";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";

// --- fixtures -----------------------------------------------------------------

const EDORK_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme + nested editor text",
    time: 1_700_000_000,
    files: [
      { path: "README.md", content: "# edork seed\n" },
      { path: "notes/editor.txt", content: "edork seed: line one\n" },
    ],
  },
];

interface ForkRouteFixtures {
  baseRow: typeof repositories.$inferSelect;
  samCookie: string;
  patCookie: string;
  aliceCookie: string;
}

let fixtures: ForkRouteFixtures | null = null;

async function ensureForkRouteFixtures(): Promise<ForkRouteFixtures> {
  if (fixtures !== null) return fixtures;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  // The base + the SETTLED fork (same history → identical oids), the fork
  // edge stamped — the repo-editor-fork.test.tsx fixture pattern.
  await ensureSeededRepo({ owner: "alice", slug: "edork", commits: EDORK_COMMITS });
  await ensureSeededRepo({ owner: "edforksam", slug: "edork", commits: EDORK_COMMITS });
  // The fork-less reader.
  const patExisting = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "edforkpat")).get();
  if (patExisting === undefined) {
    await db.insert(users).values({
      username: "edforkpat",
      usernameLower: "edforkpat",
      isAdmin: false,
      status: "active",
      visibility: "public",
      createdAt: new Date(),
    });
  }
  const baseRow = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "edork")))
    .get())!;
  const forkRow = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "edforksam"), eq(repositories.slug, "edork")))
    .get())!;
  if (forkRow.forkParent !== baseRow.id) {
    await db.update(repositories).set({ forkParent: baseRow.id }).where(eq(repositories.id, forkRow.id));
  }
  const sam = await db.select().from(users).where(eq(users.usernameLower, "edforksam")).get();
  const pat = await db.select().from(users).where(eq(users.usernameLower, "edforkpat")).get();
  const alice = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (sam === undefined || pat === undefined || alice === undefined) throw new Error("fork route fixture users missing");
  fixtures = {
    baseRow,
    samCookie: await mintSession(env.DB, sam.id),
    patCookie: await mintSession(env.DB, pat.id),
    aliceCookie: await mintSession(env.DB, alice.id),
  };
  return fixtures;
}

/** The editor GET (sam/pat/alice's shared URL — the fork flow's entry). */
async function editorGet(path: string, cookie: string): Promise<Response> {
  return await uiRouter.fetch(new Request(`https://test.local${path}`, { headers: { origin: "https://test.local", cookie: `${SESSION_COOKIE_NAME}=${cookie}` } }), uiEnv);
}

/** The /_fork POST (urlencoded, the §2.8 same-origin headers). */
async function forkPost(path: string, cookie: string, returnUri: string): Promise<Response> {
  return await uiRouter.fetch(
    new Request(`https://test.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://test.local",
        cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      },
      body: new URLSearchParams({ return_uri: returnUri }).toString(),
    }),
    uiEnv,
  );
}

beforeAll(async () => {
  await ensureForkRouteFixtures();
});

// --- the route claim -----------------------------------------------------------

describe("the /_fork route claim (web.go:1450's underscore literal)", () => {
  it("parses the {branch} tail into the editor-fork family — the bare literal stays unclaimed", () => {
    expect(parseUiRoute("/alice/edork/_fork/main")).toEqual({ family: "editor-fork", owner: "alice", repo: "edork", refSuffix: "main" });
    expect(parseUiRoute("/alice/edork/_fork/feature/x")).toEqual({ family: "editor-fork", owner: "alice", repo: "edork", refSuffix: "feature/x" });
    expect(parseUiRoute("/alice/edork/_fork")).toBeNull(); // chi's `/*` requires the tail
  });

  it("a GET misses to the plain 404 (POST-only registration — upstream chi 405s, the recorded house divergence)", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const res = await editorGet("/alice/edork/_fork/main", patCookie);
    expect(res.status).toBe(404);
    const barePost = await forkPost("/alice/edork/_fork", patCookie, "");
    expect(barePost.status).toBe(404);
  });
});

// --- the reader without write → the prompt ---------------------------------------

describe("the reader-without-write arm (the gate's non-writer split)", () => {
  it("the editor GET renders the fork prompt — the /_fork action, the editor URL as return_uri, not the editor form", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const res = await editorGet("/alice/edork/edit/main/notes/editor.txt", patCookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Fork Repository to Propose Changes" class="page-content repository">');
    expect(html).toContain('<form class="ui form form-fetch-action" method="post" action="/alice/edork/_fork/main">');
    expect(html).toContain('<input type="hidden" name="return_uri" value="/alice/edork/edit/main/notes/editor.txt"/>');
    expect(html).toContain('<button type="submit" class="ui primary button">Fork Repository</button>');
    expect(html).not.toContain('<textarea id="edit_area"');
    expect(html).not.toContain("from_base_branch");
  });

  it("the new-file GET's query rides the reload target (?filename=)", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const res = await editorGet("/alice/edork/new/main?filename=x.txt", patCookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<input type="hidden" name="return_uri" value="/alice/edork/new/main?filename=x.txt"/>');
  });

  it("an unresolvable branch tail 404-shells (the RepoRefByType arm — upstream resolves before the handler)", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const res = await editorGet("/alice/edork/edit/ghost/notes/editor.txt", patCookie);
    expect(res.status).toBe(404);
  });
});

// --- the POST → created + the reload ---------------------------------------------

describe("the /_fork POST (ForkToEditPost's route arm)", () => {
  it("creates the fork and 303s onto the return_uri (the reload); the row lands 'creating' with the fork edge", async () => {
    const { patCookie, baseRow } = await ensureForkRouteFixtures();
    const res = await forkPost("/alice/edork/_fork/main", patCookie, "/alice/edork/edit/main/notes/editor.txt");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/edork/edit/main/notes/editor.txt");
    const fork = await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "edforkpat"), eq(repositories.slug, "edork")))
      .get();
    expect(fork).toBeDefined();
    expect(fork?.forkParent).toBe(baseRow.id);
    expect(fork?.status).toBe("creating");
    expect(fork?.defaultBranch).toBe(baseRow.defaultBranch);
  });

  it("the double-POST race answers the reload arm (one fork row, the second POST 303s the same target)", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const first = await forkPost("/alice/edork/_fork/main", patCookie, "/alice/edork/edit/main/notes/editor.txt");
    expect(first.status).toBe(303);
    const second = await forkPost("/alice/edork/_fork/main", patCookie, "/alice/edork/edit/main/notes/editor.txt");
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe("/alice/edork/edit/main/notes/editor.txt");
    const forks = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "edforkpat"), eq(repositories.slug, "edork")))
      .all();
    expect(forks.length).toBe(1);
  });

  it("a forged cross-repo return_uri falls back to the editor root for the POST's branch (editorForkReturnTarget)", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const res = await forkPost("/alice/edork/_fork/main", patCookie, "/other/repo/edit/main");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/edork/edit/main");
  });

  it("an anonymous POST 303s onto the login round-trip (reqSignIn's posture)", async () => {
    await ensureForkRouteFixtures();
    const res = await uiRouter.fetch(
      new Request("https://test.local/alice/edork/_fork/main", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
        body: new URLSearchParams({ return_uri: "/alice/edork/edit/main" }).toString(),
      }),
      uiEnv,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fedork%2F_fork%2Fmain");
  });

  it("an unresolvable branch POST 404-shells before the write", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const res = await forkPost("/alice/edork/_fork/ghost", patCookie, "/alice/edork/edit/main");
    expect(res.status).toBe(404);
  });

  it("an archived source 404s before the write (RepoMustNotBeArchived's posture)", async () => {
    const { patCookie, baseRow } = await ensureForkRouteFixtures();
    const db = drizzle(env.DB);
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, baseRow.id));
    const res = await forkPost("/alice/edork/_fork/main", patCookie, "/alice/edork/edit/main");
    expect(res.status).toBe(404);
    await db.update(repositories).set({ isArchived: false }).where(eq(repositories.id, baseRow.id));
  });
});

// --- the edit re-targeted (the WillSubmitToFork route arm) ------------------------

describe("the editor GET re-targets onto the fork (the overlay fold)", () => {
  it("with the fork present the GET renders the fork's editor route, the banner, and the fork's branch select (the settling-fork strand: the default branch alone)", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const created = await forkPost("/alice/edork/_fork/main", patCookie, "/alice/edork/edit/main/notes/editor.txt");
    expect(created.status).toBe(303);
    const res = await editorGet("/alice/edork/edit/main/notes/editor.txt", patCookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    // TargetFormAction: the fork's editor route carrying from_base_branch.
    expect(html).toContain('<form class="ui edit form" method="post" action="/edforkpat/edork/edit/main/notes/editor.txt?from_base_branch=main">');
    expect(html).toContain('<div class="ui blue message">');
    expect(html).toContain('<b><a href="/edforkpat/edork">edforkpat/edork</a></b>');
    // The select carries the fork's default branch (the 'creating' cell has
    // no refs yet — loadEditorForkOverlay's fallback strand).
    expect(html).toContain('<option value="main" selected="">main</option>');
    expect(html).not.toContain("<h3>Fork Repository to Propose Changes</h3>");
  });

  it("a SETTLED fork lists its live branches in the select (sam's seeded cell)", async () => {
    const { samCookie } = await ensureForkRouteFixtures();
    const res = await editorGet("/alice/edork/edit/main/notes/editor.txt", samCookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/edforksam/edork/edit/main/notes/editor.txt?from_base_branch=main"');
    expect(html).toContain('<b><a href="/edforksam/edork">edforksam/edork</a></b>');
    expect(html).toContain('<option value="main" selected="">main</option>');
    // The textarea carries the BASE blob's text (upstream reads ctx.Repo).
    expect(html).toContain("edork seed: line one");
  });

  it("the upload GET folds the same overlay — the commit onto the fork's route, the dropzone BASE-anchored", async () => {
    const { patCookie } = await ensureForkRouteFixtures();
    const created = await forkPost("/alice/edork/_fork/main", patCookie, "/alice/edork/upload/main");
    expect(created.status).toBe(303);
    const res = await editorGet("/alice/edork/upload/main/notes", patCookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form class="ui form form-fetch-action repo-file-upload" method="post" action="/edforkpat/edork/upload/main/notes?from_base_branch=main">');
    expect(html).toContain('<div class="ui blue message">');
    expect(html).toContain('data-upload-url="/alice/edork/upload-file"');
  });

  it("the WRITER's editor GET stays overlay-free (the base action, no banner — the byte-identity arm at route level)", async () => {
    const { aliceCookie } = await ensureForkRouteFixtures();
    const res = await editorGet("/alice/edork/edit/main/notes/editor.txt", aliceCookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form class="ui edit form" method="post" action="/alice/edork/edit/main/notes/editor.txt">');
    expect(html).not.toContain('<div class="ui blue message">');
    expect(html).not.toContain("_fork/");
    expect(html).not.toContain("from_base_branch");
  });
});
