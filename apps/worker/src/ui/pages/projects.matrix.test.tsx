/**
 * The PROJECTS family's DEFERRED route-level matrix (pages/owner-projects.tsx
 * + pages/owner-project-board.tsx + pages/repo-projects.tsx — the wave-37
 * list, the wave-40 owner board/write group and the wave-45 repo surface;
 * the base route tests in ui/__tests__/pages-wave37.test.ts,
 * pages-wave40-projects-board.test.ts and pages-wave45-repo-projects.test.ts
 * own the base arms: the parser claims, the read ladders (private/limited
 * users, private orgs), the board renders with the visibility-filtered
 * cards + in-memory facet filters, the create/edit/status/delete round-trips
 * with their title-binding re-renders, the column create/set-default with
 * the color 422, the workflow form-POST contract with its exact 422s, the
 * anon /new 303s, the non-writer 404s, the POST-only tails' GET 405s
 * (delete/columns-new/default), the unit toggle and the repo containment).
 * THIS FILE adds the arms neither file carries, driven over the mounted
 * uiRouter on the labels ef23c5e matrix's minted-session pattern (every
 * form POST carries the browser's same-origin Origin header, so the §2.8
 * guard's happy path rides each write):
 *
 *   - the §2.8 cross-origin 403s (route-level unpinned for the whole
 *     family): a valid owner cookie still 403s on new/edit/close/delete and
 *     nothing is written (D1 read-backs), and a cookie-less cross-origin
 *     POST 403s BEFORE the anonymous login 303 (the guard fronts reqSignIn
 *     on BOTH scopes — every projects POST handler runs sameOriginGuard
 *     ahead of the session resolution);
 *   - the gates' remaining arms: the anonymous GET on the edit FORMs 303s
 *     carrying the exact paths (only the /new GET 303 was pinned), the
 *     archived repo keeps its reads at 200 but 404-shells EVERY write incl.
 *     the GET edit form for the owner (the shared repo write gate's order —
 *     anonymous, then archived-or-not-a-writer; wave 45 pinned only
 *     POST /new), the SITE ADMIN on an org board reads it but 404s its
 *     writes (orgProjectsAccessMode has no admin short-circuit — the
 *     contrast with the repo scope's admin arm wave 45 pinned, and the
 *     CanManageWorkflows org arm's admin short-circuit sits BEHIND this
 *     gate so it is unreachable for a non-member), and the org
 *     projects-unit WRITER (a team write grant, not the owner) passes the
 *     write gate on a column create (the write-pass twin of wave 40's
 *     render-only pin);
 *   - the create round-trip's deferred enum arms: a junk template_type /
 *     card_type re-renders at 200 with the exact binding text and the kept
 *     title, and nothing is written (the waves pinned only the empty/
 *     too-long title pair);
 *   - the edit round-trip's deferred arms: the GET form renders the STORED
 *     values and rides ?redirect=project into the hidden field, an
 *     empty-title POST answers AFTER the scoped lookup with the row
 *     untouched, an explicit junk template_type still gates the edit POST
 *     (the create-only field shares the validator), and a numeric-miss
 *     delete 404s at the depth prologue BEFORE the write gate;
 *   - the column create's deferred empty-title arm (only the color 422 was
 *     pinned): the board re-renders at 200 and no column lands;
 *   - the claim pins the waves carry at parse level only, answered
 *     route-level here: the upstream PUT/DELETE/JSON board-helper arms
 *     (`/move`, `/{columnID}`, `/{columnID}/move`) stay engine-owned on
 *     BOTH scopes (the plain sub-app 404, never the UI not-found shell),
 *     and the POST-only workflow-delete tail answers GET with chi's 405.
 *
 * ESCALATED RED (real bug, one line, a shared file — NOT this file's to
 * fix): the REPO scope never registered the GET 405 twin for
 * `/projects/{id}/workflows/{wid}/delete` — upstream mounts
 * addProjectWorkflowRoutes (POST-only delete tail) identically in BOTH
 * groups (web.go:1140-1155 owner / web.go:1544-1563 repo), and the owner
 * scope carries `uiRouter.get("/:owner/-/projects/:id/workflows/:wid/delete",
 * () => methodNotAllowed("POST"))` since the wave-40 landing (9b49cd2); the
 * wave-45 repo block stopped at the POST line, so a GET there misses into
 * the sub-app's plain 404 where chi answers 405 + Allow: POST. The arm
 * below pins the upstream behavior and is left RED for the orchestrator to
 * flip green by adding the one missing registration after index.ts's
 * repo-scope repoProjectWorkflowDeleteSubmit line.
 *
 * Rerun posture: the fixtures are D1-only rows (the projects pages never
 * read the engine), every seeded row is existence-checked before insert,
 * the one write arm that lands (the org writer's column) purges its target
 * title through the landed service arms first, and every other write arm
 * either 403s/404s or validates away — reruns converge.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  createProject,
  deleteColumnById,
  findProjectById,
  listColumns,
  listProjects,
  orgProjectScope,
  repoProjectScope,
  userProjectScope,
} from "../../api/services/projects";
import { repositories, repoSettings, teamMembers, teams, users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { uiRouter } from "../index";
import { uiEnv } from "../__tests__/harness";
import { mintSession, SESSION_COOKIE_NAME } from "../session";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's same-origin header (the §2.8 guard's
 *  happy path — the router fixture origin). */
function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
    },
    body: new URLSearchParams(fields).toString(),
  };
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

/** The cross-origin write shape (the guard's 403 arm). */
const crossOriginPost = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://evil.example",
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(fields).toString(),
});

// --- fixtures (D1-only — the projects pages never read the engine) ---------------

const ORG_NAME = "projmxorg";
const OWNER_NAME = "projmx-owner";
const REPO_SLUG = "projmx-lab";
const ARCHIVED_SLUG = "projmx-arch";

interface ProjectsFixture {
  ownerCookie: string;
  adminCookie: string;
  orgOwnerCookie: string;
  orgWriterCookie: string;
  ownerId: number;
  userBoardId: number;
  orgBoardId: number;
  repoBoardId: number;
  archivedBoardId: number;
  userColumnId: number;
}

let projectsFixture: ProjectsFixture | null = null;

/** Purge a create-test target column through the landed service arms — a
 *  no-op when the title is absent (the rerun convergence posture). */
async function purgeColumnTitled(projectId: number, title: string): Promise<void> {
  const { items } = await listColumns(env.DB, projectId, 1, 100);
  for (const column of items) {
    if (column.title === title) await deleteColumnById(env.DB, column, new Date());
  }
}

async function ensureProjectsFixtures(): Promise<ProjectsFixture> {
  if (projectsFixture !== null) return projectsFixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();

  // The principals: the owner (user scope + the repos), a site admin, a
  // plain outsider, the org owner and the org's projects-unit writer.
  for (const principal of [
    { username: OWNER_NAME, isAdmin: false },
    { username: "projmx-admin", isAdmin: true },
    { username: "projmx-orgowner", isAdmin: false },
    { username: "projmx-orgwriter", isAdmin: false },
  ]) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, principal.username))
      .get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: principal.username,
        usernameLower: principal.username,
        isAdmin: principal.isAdmin,
        status: "active",
        visibility: "public",
        createdAt: new Date(),
      });
    }
  }
  const owner = await db.select().from(users).where(eq(users.usernameLower, OWNER_NAME)).get();
  const admin = await db.select().from(users).where(eq(users.usernameLower, "projmx-admin")).get();
  const orgOwner = await db.select().from(users).where(eq(users.usernameLower, "projmx-orgowner")).get();
  const orgWriter = await db.select().from(users).where(eq(users.usernameLower, "projmx-orgwriter")).get();
  if (owner === undefined || admin === undefined || orgOwner === undefined || orgWriter === undefined) {
    throw new Error("projects matrix identity rows missing");
  }
  const ownerId = owner.id;

  // The org (owned by projmx-orgowner) with its writer team + board.
  const orgs = new OrgService(env.DB);
  let org = await orgs.getOrgByUsername(ORG_NAME);
  if (org === null) {
    org = await orgs.createOrg({ name: ORG_NAME, ownerId: orgOwner.id, visibility: "public", now: new Date() });
  }
  const existingTeam = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.orgId, org.id), eq(teams.lowerName, "writers")))
    .get();
  if (existingTeam === undefined) {
    const inserted = await db
      .insert(teams)
      .values({ orgId: org.id, lowerName: "writers", name: "writers", authorize: "write", visibility: "private" })
      .returning({ id: teams.id })
      .all();
    const teamId = inserted[0]!.id;
    await db.insert(teamMembers).values({ orgId: org.id, teamId, userId: orgWriter.id });
  }
  const orgScope = orgProjectScope(org.id);
  let orgBoardId: number;
  const existingOrgBoard = (await listProjects(env.DB, orgScope, false, 1, 50)).items.find(
    (row) => row.title === "Org Matrix Board",
  );
  if (existingOrgBoard === undefined) {
    orgBoardId = (
      await createProject(env.DB, orgScope, {
        title: "Org Matrix Board",
        description: "",
        template_type: "basic_kanban",
        card_type: "images_and_text",
        creatorId: orgOwner.id,
        now: new Date(),
      })
    ).id;
  } else {
    orgBoardId = existingOrgBoard.id;
  }

  // The repos: the live lab (unit on) and the row-only ARCHIVED twin (unit
  // on, isArchived flipped). Both carry a board so the gate arms have real
  // rows to resolve before refusing.
  const service = new RepoService(env.DB);
  async function ensureRepo(slug: string): Promise<string> {
    const existing = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER_NAME), eq(repositories.slug, slug)))
      .get();
    const id =
      existing?.id ??
      (
        await service.create({
          owner: { id: ownerId, usernameLower: OWNER_NAME },
          name: slug,
          isPrivate: false,
          status: "ready",
        })
      ).id;
    // The projects unit is the settings row's flag (a missing row is the
    // disabled default) — idempotent upsert.
    await db.insert(repoSettings).values({ repoId: id, hasProjects: true }).onConflictDoNothing();
    return id;
  }
  const labRepoId = await ensureRepo(REPO_SLUG);
  const archivedRepoId = await ensureRepo(ARCHIVED_SLUG);
  const archivedRow = await db
    .select({ isArchived: repositories.isArchived })
    .from(repositories)
    .where(eq(repositories.id, archivedRepoId))
    .get();
  if (archivedRow !== undefined && !archivedRow.isArchived) {
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, archivedRepoId));
  }

  async function ensureBoard(repoId: string, title: string, description: string): Promise<number> {
    const scope = repoProjectScope(repoId);
    const existing = (await listProjects(env.DB, scope, false, 1, 50)).items.find((row) => row.title === title);
    if (existing !== undefined) return existing.id;
    return (
      await createProject(env.DB, scope, {
        title,
        description,
        template_type: "basic_kanban",
        card_type: "images_and_text",
        creatorId: ownerId,
        now: new Date(),
      })
    ).id;
  }
  const repoBoardId = await ensureBoard(labRepoId, "Repo Matrix Board", "the *matrix* board");
  const archivedBoardId = await ensureBoard(archivedRepoId, "Archived Matrix Board", "");

  // The user-scope board (the `/-/projects` owner arm) — the template seeds
  // its columns, one of which grounds the board-helper claim pins.
  const userScope = userProjectScope(owner.id);
  let userBoardId: number;
  const existingUserBoard = (await listProjects(env.DB, userScope, false, 1, 50)).items.find(
    (row) => row.title === "Matrix Owner Board",
  );
  if (existingUserBoard === undefined) {
    userBoardId = (
      await createProject(env.DB, userScope, {
        title: "Matrix Owner Board",
        description: "the *owner* board",
        template_type: "basic_kanban",
        card_type: "images_and_text",
        creatorId: owner.id,
        now: new Date(),
      })
    ).id;
  } else {
    userBoardId = existingUserBoard.id;
  }
  const userColumnId = (await listColumns(env.DB, userBoardId, 1, 100)).items[0]!.id;

  projectsFixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    adminCookie: await mintSession(env.DB, admin.id),
    orgOwnerCookie: await mintSession(env.DB, orgOwner.id),
    orgWriterCookie: await mintSession(env.DB, orgWriter.id),
    ownerId: owner.id,
    userBoardId,
    orgBoardId,
    repoBoardId,
    archivedBoardId,
    userColumnId,
  };
  return projectsFixture;
}

beforeAll(async () => {
  await ensureProjectsFixtures();
});

// --- the claim pins (route-level answers the parse pins leave open) ---------------

describe("claim pins (route-level answers the parse pins leave open)", () => {
  it("the owner scope's POST-only workflow-delete tail answers GET with chi's 405 + Allow: POST (the landed twin)", async () => {
    await ensureProjectsFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/-/projects/1/workflows/1/delete`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("ESCALATED RED: the REPO scope's workflow-delete tail must answer GET with chi's 405 too (upstream mounts addProjectWorkflowRoutes POST-only in BOTH groups) — the wave-45 registration block never added the GET 405 twin, so the sub-app's plain 404 answers", async () => {
    await ensureProjectsFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/projects/1/workflows/1/delete`);
    expect(
      res.status,
      [
        "REAL BUG (escalated to the orchestrator — see the file header):",
        `GET /${OWNER_NAME}/${REPO_SLUG}/projects/1/workflows/1/delete answered ${res.status}`,
        "where upstream chi answers 405 (Allow: POST) — the owner scope carries the",
        "methodNotAllowed twin (index.ts, the wave-40 landing 9b49cd2) and the repo",
        "scope (wave 45) stopped at the POST line. Fix: register",
        'uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid/delete", () => methodNotAllowed("POST"))',
        "after the repo-scope repoProjectWorkflowDeleteSubmit line in index.ts.",
      ].join(" "),
    ).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("the upstream PUT/DELETE/JSON board-helper arms stay engine-owned at route level on BOTH scopes (the plain sub-app 404, never the UI not-found shell)", async () => {
    const fixture = await ensureProjectsFixtures();
    const ownerBase = `/${OWNER_NAME}/-/projects/${fixture.userBoardId}`;
    const repoBase = `/${OWNER_NAME}/${REPO_SLUG}/projects/${fixture.repoBoardId}`;
    const columnId = String(fixture.userColumnId);
    // POST /move (MoveColumns) + POST /{columnID}/move (MoveIssues): the
    // drag-drop JSON fetches the no-JS reduction leaves unclaimed.
    for (const path of [`${ownerBase}/move`, `${ownerBase}/${columnId}/move`, `${repoBase}/move`]) {
      const res = await fetchUi(path, { method: "POST", headers: { origin: "https://test.local" } });
      expect(res.status, `POST ${path}`).toBe(404);
      expect(await res.text(), `POST ${path}`).not.toContain("page-content");
    }
    // PUT/DELETE /{columnID} (EditProjectColumn/DeleteProjectColumn): the
    // methods the form-compatible surface never claims.
    for (const [method, path] of [
      ["PUT", `${ownerBase}/${columnId}`],
      ["DELETE", `${ownerBase}/${columnId}`],
      ["DELETE", `${repoBase}/${columnId}`],
    ] as Array<[string, string]>) {
      const res = await fetchUi(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text(), `${method} ${path}`).not.toContain("page-content");
    }
    // GET on the move tail too — no method claims it.
    expect((await fetchUi(`${ownerBase}/move`)).status).toBe(404);
  });
});

// --- the cross-origin 403s (route-level unpinned for the whole family) -------------

describe("cross-origin 403s on the write arms (the guard fronts every POST, both scopes)", () => {
  it("a cross-origin POST new 403s even WITH a valid owner cookie and writes nothing; the cookie-less cross-origin POST 403s before the anonymous 303", async () => {
    const fixture = await ensureProjectsFixtures();
    const before = await listProjects(env.DB, userProjectScope(fixture.ownerId), false, 1, 50);
    const res = await fetchUi(
      `/${OWNER_NAME}/-/projects/new`,
      crossOriginPost(
        { title: "evil board", content: "", template_type: "none", card_type: "text_only" },
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("cross-origin request rejected");
    expect((await listProjects(env.DB, userProjectScope(fixture.ownerId), false, 1, 50)).total).toBe(before.total);

    // The guard runs FIRST: a cookie-less cross-origin POST is a 403, not
    // the anonymous login 303 the same-origin arm answers (wave 40 pinned
    // that 303 only without an Origin header).
    const anon = await fetchUi(`/${OWNER_NAME}/-/projects/new`, crossOriginPost({ title: "evil board", content: "" }));
    expect(anon.status).toBe(403);
    expect(await anon.text()).toContain("cross-origin request rejected");
  });

  it("the owner edit/close/delete arms 403 cross-origin with the cookie and the row survives all three", async () => {
    const fixture = await ensureProjectsFixtures();
    const path = `/${OWNER_NAME}/-/projects/${fixture.userBoardId}`;
    const edit = await fetchUi(
      `${path}/edit`,
      crossOriginPost(
        { title: "evil rename", content: "evil", card_type: "text_only", redirect: "project" },
        fixture.ownerCookie,
      ),
    );
    expect(edit.status).toBe(403);
    const close = await fetchUi(`${path}/close`, crossOriginPost({}, fixture.ownerCookie));
    expect(close.status).toBe(403);
    const del = await fetchUi(`${path}/delete`, crossOriginPost({}, fixture.ownerCookie));
    expect(del.status).toBe(403);
    expect(await del.text()).toContain("cross-origin request rejected");
    const row = await findProjectById(env.DB, userProjectScope(fixture.ownerId), fixture.userBoardId);
    expect(row?.title).toBe("Matrix Owner Board"); // nothing touched
    expect(row?.isClosed).toBe(false);
  });

  it("the REPO scope's writes 403 cross-origin with the cookie (new/edit/delete), the rows survive, and the cookie-less POST 403s before the login 303", async () => {
    const fixture = await ensureProjectsFixtures();
    const base = `/${OWNER_NAME}/${REPO_SLUG}/projects`;
    const labId = await repoIdOf(REPO_SLUG);
    const before = await listProjects(env.DB, repoProjectScope(labId), false, 1, 50);
    const created = await fetchUi(`${base}/new`, crossOriginPost({ title: "evil repo board", content: "" }, fixture.ownerCookie));
    expect(created.status).toBe(403);
    expect(await created.text()).toContain("cross-origin request rejected");
    const edit = await fetchUi(
      `${base}/${fixture.repoBoardId}/edit`,
      crossOriginPost({ title: "evil rename", content: "", card_type: "text_only" }, fixture.ownerCookie),
    );
    expect(edit.status).toBe(403);
    const del = await fetchUi(`${base}/${fixture.repoBoardId}/delete`, crossOriginPost({}, fixture.ownerCookie));
    expect(del.status).toBe(403);
    const after = await listProjects(env.DB, repoProjectScope(labId), false, 1, 50);
    expect(after.total).toBe(before.total); // no evil row, nothing deleted
    const row = await findProjectById(env.DB, repoProjectScope(labId), fixture.repoBoardId);
    expect(row?.title).toBe("Repo Matrix Board");

    // The repo guard fronts reqSignIn too.
    const anon = await fetchUi(`${base}/new`, crossOriginPost({ title: "evil repo board", content: "" }));
    expect(anon.status).toBe(403);
    expect(await anon.text()).toContain("cross-origin request rejected");
  });
});

// --- the write gates' remaining arms ------------------------------------------------

describe("the write gates' remaining arms", () => {
  it("anonymous GET on the edit FORMs 303s carrying the exact paths (the write gate fronts the GET arm; only /new was pinned)", async () => {
    const fixture = await ensureProjectsFixtures();
    // The depth prologue's scoped lookup runs BEFORE the gate, so the arm
    // rides the real board ids (a junk id 404s at the lookup, never 303s).
    const ownerPath = `/${OWNER_NAME}/-/projects/${fixture.userBoardId}/edit`;
    const ownerRes = await fetchUi(ownerPath);
    expect(ownerRes.status).toBe(303);
    expect(ownerRes.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(ownerPath)}`);

    const repoPath = `/${OWNER_NAME}/${REPO_SLUG}/projects/${fixture.repoBoardId}/edit`;
    const repoRes = await fetchUi(repoPath);
    expect(repoRes.status).toBe(303);
    expect(repoRes.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(repoPath)}`);
  });

  it("an archived repo keeps both reads at 200 but 404-shells EVERY write incl. the GET edit form for the owner (archived precedes the writer grant)", async () => {
    const fixture = await ensureProjectsFixtures();
    const base = `/${OWNER_NAME}/${ARCHIVED_SLUG}/projects`;
    // The reads stay (the unit is on; the read group never checks archived).
    expect((await fetchUi(base)).status).toBe(200);
    const board = await fetchUi(`${base}/${fixture.archivedBoardId}`);
    expect(board.status).toBe(200);
    expect(await board.text()).toContain("Archived Matrix Board");

    // The write ladder's order — anonymous first, then archived-or-not-a-
    // writer: the OWNER would pass the writer arm on a live repo, so every
    // refusal here is the archived check.
    const editForm = await fetchUi(`${base}/${fixture.archivedBoardId}/edit`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(editForm.status).toBe(404); // the render never runs
    const edit = await fetchUi(
      `${base}/${fixture.archivedBoardId}/edit`,
      withCookie(formPost({ title: "archived write", content: "", card_type: "text_only" }), fixture.ownerCookie),
    );
    expect(edit.status).toBe(404);
    const close = await fetchUi(`${base}/${fixture.archivedBoardId}/close`, withCookie(formPost({}), fixture.ownerCookie));
    expect(close.status).toBe(404);
    const del = await fetchUi(`${base}/${fixture.archivedBoardId}/delete`, withCookie(formPost({}), fixture.ownerCookie));
    expect(del.status).toBe(404);
    const column = await fetchUi(
      `${base}/${fixture.archivedBoardId}/columns/new`,
      withCookie(formPost({ title: "archived column", color: "#00aabb" }), fixture.ownerCookie),
    );
    expect(column.status).toBe(404);
    // Nothing landed.
    const row = await findProjectById(env.DB, repoProjectScope(await repoIdOf(ARCHIVED_SLUG)), fixture.archivedBoardId);
    expect(row?.title).toBe("Archived Matrix Board");
    expect(row?.isClosed).toBe(false);
  });

  it("the SITE ADMIN reads an org board but 404s its writes (orgProjectsAccessMode has no admin short-circuit — the repo scope's admin arm does not carry over)", async () => {
    const fixture = await ensureProjectsFixtures();
    const path = `/${ORG_NAME}/-/projects/${fixture.orgBoardId}`;
    // The read ladder admits the admin (a public org answers any viewer).
    const board = await fetchUi(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` } });
    expect(board.status).toBe(200);
    expect(await board.text()).not.toContain("New Column"); // canWriteProjects is false
    // The write group refuses: read < write, membership or not.
    const column = await fetchUi(
      `${path}/columns/new`,
      withCookie(formPost({ title: "Admin Column", color: "#00aabb" }), fixture.adminCookie),
    );
    expect(column.status).toBe(404);
    const columns = await listColumns(env.DB, fixture.orgBoardId, 1, 100);
    expect(columns.items.some((entry) => entry.title === "Admin Column")).toBe(false);
  });

  it("the org projects-unit WRITER (a team write grant, not the owner) passes the write gate: a column create lands (the write-pass twin of wave 40's render pin)", async () => {
    const fixture = await ensureProjectsFixtures();
    const path = `/${ORG_NAME}/-/projects/${fixture.orgBoardId}`;
    await purgeColumnTitled(fixture.orgBoardId, "Matrix Review");
    const res = await fetchUi(
      `${path}/columns/new`,
      withCookie(formPost({ title: "Matrix Review", color: "#00aabb" }), fixture.orgWriterCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(path);
    const board = await (
      await fetchUi(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } })
    ).text();
    expect(board).toContain("Matrix Review");
  });
});

// --- the create round-trip's deferred enum arms -------------------------------------

describe("the create round-trip's deferred enum arms (only the title binding was pinned)", () => {
  it("a junk template_type re-renders at 200 with the exact binding text and the kept title; nothing is written", async () => {
    const fixture = await ensureProjectsFixtures();
    const before = await listProjects(env.DB, userProjectScope(fixture.ownerId), false, 1, 50);
    const res = await fetchUi(
      `/${OWNER_NAME}/-/projects/new`,
      withCookie(
        formPost({ title: "Matrix Junk Template", content: "kept", template_type: "bogus", card_type: "text_only" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid template type.");
    expect(html).toContain('value="Matrix Junk Template"'); // the kept submission
    expect((await listProjects(env.DB, userProjectScope(fixture.ownerId), false, 1, 50)).total).toBe(before.total);
  });

  it("a junk card_type re-renders at 200 with the exact binding text (the repo scope); nothing is written", async () => {
    const fixture = await ensureProjectsFixtures();
    const base = `/${OWNER_NAME}/${REPO_SLUG}/projects`;
    const labId = await repoIdOf(REPO_SLUG);
    const before = await listProjects(env.DB, repoProjectScope(labId), false, 1, 50);
    const res = await fetchUi(
      `${base}/new`,
      withCookie(
        formPost({ title: "Matrix Junk Card", content: "", template_type: "basic_kanban", card_type: "bogus" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid card type.");
    expect(html).toContain('value="Matrix Junk Card"'); // the kept submission
    expect((await listProjects(env.DB, repoProjectScope(labId), false, 1, 50)).total).toBe(before.total);
  });
});

// --- the edit/delete round-trips' deferred arms --------------------------------------

describe("the edit/delete round-trips' deferred arms", () => {
  it("the GET edit form renders the STORED values and rides ?redirect=project into the hidden field", async () => {
    const fixture = await ensureProjectsFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/-/projects/${fixture.userBoardId}/edit?redirect=project`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Edit Project"); // the edit heading (the create arm's label swaps)
    expect(html).toContain('id="redirect" name="redirect" value="project"');
    expect(html).toContain('value="Matrix Owner Board"'); // the stored title
    expect(html).toContain("the *owner* board"); // the raw description rides the textarea
    expect(html).toContain('value="images_and_text" selected=""'); // the stored card type
    // The create-only template select is hidden on the edit arm.
    expect(html).not.toContain('id="project-template"');
  });

  it("the repo edit's empty-title guard answers AFTER the scoped lookup and leaves the row stored", async () => {
    const fixture = await ensureProjectsFixtures();
    const res = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/projects/${fixture.repoBoardId}/edit`,
      withCookie(
        formPost({ title: "", content: "ignored", card_type: "text_only", redirect: "project" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("A title is required.");
    const row = await findProjectById(env.DB, repoProjectScope(await repoIdOf(REPO_SLUG)), fixture.repoBoardId);
    expect(row?.title).toBe("Repo Matrix Board"); // untouched
    expect(row?.description).toBe("the *matrix* board");
  });

  it("an explicit junk template_type still gates the edit POST (the create-only field shares the validator); the row is untouched", async () => {
    const fixture = await ensureProjectsFixtures();
    const res = await fetchUi(
      `/${OWNER_NAME}/-/projects/${fixture.userBoardId}/edit`,
      withCookie(
        formPost({ title: "Matrix Owner Board", content: "ignored", template_type: "bogus", card_type: "text_only" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Invalid template type.");
    const row = await findProjectById(env.DB, userProjectScope(fixture.ownerId), fixture.userBoardId);
    expect(row?.description).toBe("the *owner* board"); // the write never ran
  });

  it("a numeric-miss delete 404s at the depth prologue BEFORE the write gate (the scoped lookup precedes the ladder)", async () => {
    const fixture = await ensureProjectsFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/projects/999999/delete`, {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}`,
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://test.local",
      },
    });
    expect(res.status).toBe(404);
  });
});

// --- the column create's deferred empty-title arm -------------------------------------

describe("the column create's deferred empty-title arm (only the color 422 was pinned)", () => {
  it("an empty title re-renders the board at 200 and no column lands", async () => {
    const fixture = await ensureProjectsFixtures();
    const before = await listColumns(env.DB, fixture.repoBoardId, 1, 100);
    const res = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/projects/${fixture.repoBoardId}/columns/new`,
      withCookie(formPost({ title: "", color: "#00aabb" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A title is required.");
    expect(html).toContain("Repo Matrix Board"); // the board re-rendered, not a shell
    const after = await listColumns(env.DB, fixture.repoBoardId, 1, 100);
    expect(after.total).toBe(before.total);
  });
});

// --- helpers ---------------------------------------------------------------------------

/** A repo's id by slug (the fixtures hold slugs only for stability). */
async function repoIdOf(slug: string): Promise<string> {
  const db = drizzle(env.DB);
  const row = await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, slug)).get();
  if (row === undefined) throw new Error(`repo ${slug} not seeded`);
  return row.id;
}
