/**
 * Pages wave 40 route tests — the UI-parity survey's ABSENT follow-up row
 * (docs/compat/ui-parity-survey.md: web.go:1140-1155 + the board/workflow
 * helpers web.go:327-345): the `/{username}/-/projects/{id}` BOARD view, its
 * write group (`/new`, `/{id}/edit|delete|open|close`), the form-compatible
 * board-helper POSTs (`/columns/new`, `/{columnID}/default`) and the
 * workflow tails (`/{id}/workflows[/{workflow_id}[/delete]]`) over the
 * landed projects service family.
 *
 * Pins asserted:
 *   - the parser claims exactly the board/write shapes (the wave-37 flip):
 *     the `new` literal, the numeric-id shapes, the workflows tails — junk
 *     ids, deeper tails, and the PUT/DELETE/JSON board-helper arms
 *     (`/move`, `/{columnID}`, `/{columnID}/move`) stay unclaimed → the
 *     engine's 404;
 *   - the board's READ surface: columns in `sorting, id` order with the
 *     default star, the visibility-FILTERED per-column counts and cards
 *     (anonymous excludes private-repo items, the owner includes them), the
 *     card links (issue/pulls title hrefs, milestone), and the facet
 *     filters honored in memory (`?labels=`, `?assignee=`, `?milestone=` —
 *     the count reflects the filter, projects.go:354-356);
 *   - the gates: the LIST page's read resolution (the private-user follower
 *     404), the write group's reqSignIn 303 + canWriteProjects 404 (the
 *     web.go:1151-1155 arm — even a SITE ADMIN is a NotFound on another
 *     user's project writes), and the workflows' CanManageWorkflows second
 *     layer (an org projects-writer who is not the org owner reads the
 *     workflows but 404s on its writes);
 *   - the write forms: create (template columns seeded), edit
 *     (redirect=project), open/close, delete, column create + set-default —
 *     303s onto upstream's redirect targets, the binding/validation
 *     failures re-render at 200 with the kept submission;
 *   - the workflow form-POST contract: create (the service's exact 422s
 *     re-render), the enable/disable toggle (enabled-only POST keeps the
 *     stored rules), the full-rule replace, delete, and the unknown
 *     `?event=`/`?workflow_id=` 404 arms.
 *
 * Same harness posture as pages-wave37: the router is driven directly with
 * the synthetic ASSETS manifest; D1-only fixtures (no engine content).
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import {
  comments,
  follows,
  issueAssignees,
  issueLabels,
  issues,
  labels,
  milestones,
  projectIssues,
  repoCounters,
  repositories,
  teamMembers,
  teams,
  users,
} from "../../db/schema";
import {
  addIssueToColumn,
  createColumn,
  createProject,
  findProjectById,
  listColumns,
  orgProjectScope,
  userProjectScope,
} from "../../api/services/projects";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { uiEnv } from "./harness";
import { IssuesService } from "../../issues/service";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import type { OrgRecord } from "../../services/orgs/orgs";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (path: string, cookie: string): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

const formPost = (path: string, cookie: string, body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: {
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams(body).toString(),
});

const NOW = new Date(1_700_000_000 * 1000);
const db = () => drizzle(env.DB);

// --- fixtures -----------------------------------------------------------------

interface Wave40Fixture {
  ownerCookie: string; // wave40-user — the public user arm's owner
  privCookie: string; // wave40-priv — a private user with a board
  adminCookie: string; // wave40-admin — a site admin
  outCookie: string; // wave40-out — a signed-in outsider
  followerCookie: string; // wave40-follower — follows the private user
  orgOwnerCookie: string; // wave40-orgowner — owns the public org
  orgWriterCookie: string; // wave40-orgwriter — projects-unit write, not the owner
  ownerId: number;
  boardId: number;
  orgBoardId: number;
  privBoardId: number;
  pubRepoSlug: string;
  privRepoSlug: string;
  milestoneId: number;
  bugLabelId: number;
}

let wave40Fixture: Wave40Fixture | null = null;

async function seedIssue(repoId: string, index: number, isClosed = false) {
  const rows = await db()
    .insert(issues)
    .values({ repoId, index, title: `Board issue ${index}`, createdAt: NOW, updatedAt: NOW, isClosed })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("issue seed failed");
  return row;
}

async function ensureWave40Fixtures(): Promise<Wave40Fixture> {
  if (wave40Fixture !== null) return wave40Fixture;
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "wave40-user" });
  const priv = await seedVerifiedUser({ username: "wave40-priv" });
  const admin = await seedVerifiedUser({ username: "wave40-admin", isAdmin: true });
  const out = await seedVerifiedUser({ username: "wave40-out" });
  const follower = await seedVerifiedUser({ username: "wave40-follower" });
  const orgOwner = await seedVerifiedUser({ username: "wave40-orgowner" });
  const orgWriter = await seedVerifiedUser({ username: "wave40-orgwriter" });

  await db().update(users).set({ visibility: "private" }).where(eq(users.id, priv.id));
  await db().insert(follows).values({ userId: follower.id, followId: priv.id, createdAt: NOW });

  const repos = new RepoService(env.DB);
  const pubRepo = await repos.create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: "wave40-pub",
    isPrivate: false,
    status: "ready",
  });
  const privRepo = await repos.create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: "wave40-priv-lab",
    isPrivate: true,
    status: "ready",
  });

  // The owner's board: the basic_kanban template (Backlog + To Do/In
  // Progress/Done, Backlog the default), two public issues in "To Do", one
  // closed in "Done", and a PRIVATE-repo issue in "Backlog" (the visibility
  // matrix arm).
  const board = await createProject(env.DB, userProjectScope(owner.id), {
    title: "Feature Board",
    description: "The *wave 40* board",
    template_type: "basic_kanban",
    card_type: "images_and_text",
    creatorId: owner.id,
    now: NOW,
  });
  const columns = (await listColumns(env.DB, board.id, 1, 100)).items;
  const backlog = columns.find((column) => column.title === "Backlog");
  const todo = columns.find((column) => column.title === "To Do");
  const done = columns.find((column) => column.title === "Done");
  if (backlog === undefined || todo === undefined || done === undefined) throw new Error("template columns missing");

  const pubIssue1 = await seedIssue(pubRepo.id, 1);
  const pubIssue2 = await seedIssue(pubRepo.id, 2);
  await seedIssue(pubRepo.id, 3, true); // open-count filler in no column
  const privIssue = await seedIssue(privRepo.id, 1);
  await addIssueToColumn(env.DB, board, pubIssue1, todo, owner.id, NOW);
  await addIssueToColumn(env.DB, board, pubIssue2, todo, owner.id, NOW);
  await addIssueToColumn(env.DB, board, privIssue, backlog, owner.id, NOW);
  const doneIssue = await seedIssue(pubRepo.id, 4, true);
  await addIssueToColumn(env.DB, board, doneIssue, done, owner.id, NOW);

  // The facet fixtures: a milestone on pubIssue1, a repo label on pubIssue2,
  // an assignee on pubIssue1.
  await db().insert(milestones).values({ repoId: pubRepo.id, name: "Sprint 1", createdAt: NOW, updatedAt: NOW });
  const milestoneRow = (await db().select().from(milestones).where(eq(milestones.repoId, pubRepo.id)).all())[0];
  if (milestoneRow === undefined) throw new Error("milestone seed failed");
  await db().update(issues).set({ milestoneId: milestoneRow.id }).where(eq(issues.id, pubIssue1.id));
  await db().insert(labels).values({ repoId: pubRepo.id, name: "bug", color: "#ee0701" });
  const labelRow = (await db().select().from(labels).where(eq(labels.name, "bug")).all())[0];
  if (labelRow === undefined) throw new Error("label seed failed");
  await db().insert(issueLabels).values({ issueId: pubIssue2.id, labelId: labelRow.id });
  await db().insert(issueAssignees).values({ issueId: pubIssue1.id, assigneeId: owner.id });

  // The private user's board (the gate arms) — empty.
  const privBoard = await createProject(env.DB, userProjectScope(priv.id), {
    title: "Private User Board",
    description: "",
    creatorId: priv.id,
    now: NOW,
  });

  // The org arm: a public org board with an org label (the workflow label
  // pool) + a projects-unit writer team (the write gate without the
  // workflow manage gate).
  const orgs = new OrgService(env.DB);
  const org: OrgRecord = await orgs.createOrg({ name: "wave40org", ownerId: orgOwner.id, visibility: "public", now: NOW });
  const orgBoard = await createProject(env.DB, orgProjectScope(org.id), {
    title: "Org Roadmap",
    description: "",
    creatorId: orgOwner.id,
    now: NOW,
  });
  // One column for the workflow replace arm's move-to-column target.
  await createColumn(env.DB, orgBoard.id, { title: "Inbox", color: "", creatorId: orgOwner.id, now: NOW });
  await db().insert(labels).values({ repoId: null, orgId: org.id, name: "org-wide", color: "#00aabb" });
  const insertedTeam = await db()
    .insert(teams)
    .values({ orgId: org.id, lowerName: "writers", name: "writers", authorize: "write", visibility: "private" })
    .returning({ id: teams.id })
    .all();
  const teamId = insertedTeam[0]!.id;
  await db().insert(teamMembers).values({ orgId: org.id, teamId, userId: orgWriter.id });

  wave40Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    privCookie: await mintSession(env.DB, priv.id),
    adminCookie: await mintSession(env.DB, admin.id),
    outCookie: await mintSession(env.DB, out.id),
    followerCookie: await mintSession(env.DB, follower.id),
    orgOwnerCookie: await mintSession(env.DB, orgOwner.id),
    orgWriterCookie: await mintSession(env.DB, orgWriter.id),
    ownerId: owner.id,
    boardId: board.id,
    orgBoardId: orgBoard.id,
    privBoardId: privBoard.id,
    pubRepoSlug: "wave40-pub",
    privRepoSlug: "wave40-priv-lab",
    milestoneId: milestoneRow.id,
    bugLabelId: labelRow.id,
  };
  return wave40Fixture;
}

beforeAll(async () => {
  await ensureWave40Fixtures();
});

// --- the parser claims (the wave-37 flip's shape contract) ----------------------

describe("wave-40 parser claims", () => {
  it("claims exactly the board/write/workflow shapes", () => {
    const owner = "wave40-user";
    expect(parseUiRoute(`/${owner}/-/projects/7`)).toEqual({ family: "owner-project-board", owner, id: 7 });
    expect(parseUiRoute(`/${owner}/-/projects/new`)).toEqual({ family: "owner-project-new", owner });
    expect(parseUiRoute(`/${owner}/-/projects/7/edit`)).toEqual({ family: "owner-project-edit", owner, id: 7 });
    expect(parseUiRoute(`/${owner}/-/projects/7/delete`)).toEqual({ family: "owner-project-delete", owner, id: 7 });
    expect(parseUiRoute(`/${owner}/-/projects/7/open`)).toEqual({
      family: "owner-project-status",
      owner,
      id: 7,
      action: "open",
    });
    expect(parseUiRoute(`/${owner}/-/projects/7/close`)).toEqual({
      family: "owner-project-status",
      owner,
      id: 7,
      action: "close",
    });
    expect(parseUiRoute(`/${owner}/-/projects/7/columns/new`)).toEqual({
      family: "owner-project-column-new",
      owner,
      id: 7,
    });
    expect(parseUiRoute(`/${owner}/-/projects/7/9/default`)).toEqual({
      family: "owner-project-column-default",
      owner,
      id: 7,
      columnId: 9,
    });
    expect(parseUiRoute(`/${owner}/-/projects/7/workflows`)).toEqual({ family: "owner-project-workflows", owner, id: 7 });
    expect(parseUiRoute(`/${owner}/-/projects/7/workflows/9`)).toEqual({
      family: "owner-project-workflows",
      owner,
      id: 7,
      workflowId: 9,
    });
    expect(parseUiRoute(`/${owner}/-/projects/7/workflows/9/delete`)).toEqual({
      family: "owner-project-workflow-delete",
      owner,
      id: 7,
      workflowId: 9,
    });
    // PathParamInt64 parity: "007" parses as 7.
    expect(parseUiRoute(`/${owner}/-/projects/007`)).toEqual({ family: "owner-project-board", owner, id: 7 });
    expect(handlesUiRoute(`/${owner}/-/projects/7/workflows/9/delete`)).toBe(true);
  });

  it("leaves the reduced arms and junk shapes unclaimed (the engine's 404)", () => {
    const owner = "wave40-user";
    // The PUT/DELETE/JSON board-helper arms (the no-JS reductions — the
    // page module's header).
    expect(parseUiRoute(`/${owner}/-/projects/7/move`)).toBeNull();
    expect(parseUiRoute(`/${owner}/-/projects/7/9`)).toBeNull();
    expect(parseUiRoute(`/${owner}/-/projects/7/9/move`)).toBeNull();
    // Junk id segments stay engine-owned (upstream's PathParamInt64-zero
    // ServerError arm — the landed uniform not-found answer).
    expect(parseUiRoute(`/${owner}/-/projects/abc`)).toBeNull();
    expect(parseUiRoute(`/${owner}/-/projects/7/abc`)).toBeNull();
    // Deeper/other tails.
    expect(parseUiRoute(`/${owner}/-/projects/7/unknown`)).toBeNull();
    expect(parseUiRoute(`/${owner}/-/projects/new/more`)).toBeNull();
    expect(handlesUiRoute(`/${owner}/-/projects/7/move`)).toBe(false);
    // The REPO-scoped shape (`/:owner/:repo/projects*` — upstream's
    // repo-level projects group, web.go:1544-1563) was held engine-owned by
    // this wave's restored `repo === "-"` guard "until the row is
    // dispatched" — wave 45 (pages/repo-projects.tsx) dispatched it, so the
    // four shapes flip from the unclaimed pins to the repo-projects
    // families (the wave-37 title-link flip's protocol).
    expect(parseUiRoute(`/${owner}/some-repo/projects`)).toEqual({ family: "repo-projects", owner, repo: "some-repo" });
    expect(parseUiRoute(`/${owner}/some-repo/projects/7`)).toEqual({
      family: "repo-project-board",
      owner,
      repo: "some-repo",
      id: 7,
    });
    expect(parseUiRoute(`/${owner}/some-repo/projects/new`)).toEqual({ family: "repo-project-new", owner, repo: "some-repo" });
    expect(parseUiRoute(`/${owner}/some-repo/projects/7/edit`)).toEqual({
      family: "repo-project-edit",
      owner,
      repo: "some-repo",
      id: 7,
    });
  });
});

// --- the board read surface -------------------------------------------------------

describe("board view GET /{owner}/-/projects/{id}", () => {
  it("renders the columns and the public cards to anonymous, hiding the private-repo arm", async () => {
    const fixture = await ensureWave40Fixtures();
    const res = await fetchUi(`/wave40-user/-/projects/${fixture.boardId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The chrome + header (the view-project page class, the title, the
    // rendered markdown description).
    expect(html).toContain("view-project");
    expect(html).toContain("Feature Board");
    expect(html).toContain("<em>wave 40</em> board");
    // The template columns in insertion order (Backlog the default).
    for (const title of ["Backlog", "To Do", "In Progress", "Done"]) {
      expect(html).toContain(title);
    }
    // The writer controls are absent for anonymous; the Workflows link is
    // everyone's.
    expect(html).not.toContain("New Column");
    expect(html).not.toContain("/edit?redirect=project");
    expect(html).toContain(`href="/wave40-user/-/projects/${fixture.boardId}/workflows"`);
    // The public cards render with their issue links — both open and the
    // closed one (in Done, with the closed glyph).
    expect(html).toContain(`href="/wave40-user/${fixture.pubRepoSlug}/issues/1"`);
    expect(html).toContain(`href="/wave40-user/${fixture.pubRepoSlug}/issues/2"`);
    expect(html).toContain(`href="/wave40-user/${fixture.pubRepoSlug}/issues/4"`);
    expect(html).toContain("octicon-issue-closed");
    // The PRIVATE-repo issue never renders to anonymous — neither the card
    // nor its repo namespace anywhere on the page.
    expect(html).not.toContain(fixture.privRepoSlug);
    // The meta line carries the repo#index prefix and the poster label.
    expect(html).toContain(`wave40-pub#1`);
    // The milestone link on the card that carries one.
    expect(html).toContain(`href="/wave40-user/${fixture.pubRepoSlug}/milestone/${fixture.milestoneId}"`);
    // The label badge links the repo's issues list with the label facet.
    expect(html).toContain(`href="/wave40-user/${fixture.pubRepoSlug}/issues?labels=${fixture.bugLabelId}"`);
  });

  it("the owner sees the private-repo card and the writer controls", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    const res = await fetchUi(path, withCookie(path, fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // The private-repo issue now renders (the Backlog card).
    expect(html).toContain(fixture.privRepoSlug);
    // The writer controls: edit link, close submit, delete submit, the New
    // Column disclosure, and the set-default buttons on non-default columns.
    expect(html).toContain(`${path}/edit?redirect=project`);
    expect(html).toContain(`${path}/close`);
    expect(html).toContain(`${path}/delete`);
    expect(html).toContain("New Column");
    expect(html).toMatch(new RegExp(`/-/projects/${fixture.boardId}/\\d+/default`));
    // The board is open — the header offers Close, not Open.
    expect(html).not.toContain(`${path}/open`);
  });

  it("the private user's board 404-shells the follower and answers self/admin (the read ladder)", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-priv/-/projects/${fixture.privBoardId}`;
    expect((await fetchUi(path)).status).toBe(404);
    expect((await fetchUi(path, withCookie(path, fixture.followerCookie))).status).toBe(404);
    expect((await fetchUi(path, withCookie(path, fixture.outCookie))).status).toBe(404);
    expect((await fetchUi(path, withCookie(path, fixture.adminCookie))).status).toBe(200);
    const self = await fetchUi(path, withCookie(path, fixture.privCookie));
    expect(self.status).toBe(200);
    expect(await self.text()).toContain("Private User Board");
  });

  it("honors the facet filters in memory and the counts reflect them", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    // The milestone filter: only pubIssue1 carries Sprint 1 — the To Do
    // count drops from 2 cards to 1.
    const byMilestone = await (
      await fetchUi(`${path}?milestone=${fixture.milestoneId}`, withCookie(`${path}?milestone=${fixture.milestoneId}`, fixture.ownerCookie))
    ).text();
    expect(byMilestone).toContain("Board issue 1");
    expect(byMilestone).not.toContain("Board issue 2");
    // The label filter: only pubIssue2 carries `bug`.
    const byLabel = await (
      await fetchUi(`${path}?labels=${fixture.bugLabelId}`, withCookie(`${path}?labels=${fixture.bugLabelId}`, fixture.ownerCookie))
    ).text();
    expect(byLabel).toContain("Board issue 2");
    expect(byLabel).not.toContain("Board issue 1");
    // The assignee filter: pubIssue1 is assigned to the owner.
    const byAssignee = await (
      await fetchUi(`${path}?assignee=${fixture.ownerId}`, withCookie(`${path}?assignee=${fixture.ownerId}`, fixture.ownerCookie))
    ).text();
    expect(byAssignee).toContain("Board issue 1");
    expect(byAssignee).not.toContain("Board issue 2");
  });

  it("a foreign owner's id reads as not found (GetProjectByIDAndOwner scoping)", async () => {
    const fixture = await ensureWave40Fixtures();
    // wave40-user's board id under wave40org's namespace → the 404 shell.
    const res = await fetchUi(
      `/wave40org/-/projects/${fixture.boardId}`,
      withCookie(`/wave40org/-/projects/${fixture.boardId}`, fixture.orgOwnerCookie),
    );
    expect(res.status).toBe(404);
  });
});

// --- the write group's gates -------------------------------------------------------

describe("write-group gates", () => {
  it("anonymous gets the login 303 on the /new form (reqSignIn)", async () => {
    await ensureWave40Fixtures();
    const get = await fetchUi("/wave40-user/-/projects/new");
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toContain("/login?redirect_to=");
    const post = await fetchUi("/wave40-user/-/projects/new", { method: "POST" });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toContain("/login?redirect_to=");
  });

  it("a signed-in non-writer 404-shells every write arm", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    expect((await fetchUi("/wave40-user/-/projects/new", withCookie("/wave40-user/-/projects/new", fixture.outCookie))).status).toBe(404);
    expect((await fetchUi(`${path}/edit`, withCookie(`${path}/edit`, fixture.outCookie))).status).toBe(404);
    expect((await fetchUi(`${path}/delete`, { method: "POST", ...withCookie(`${path}/delete`, fixture.outCookie) })).status).toBe(404);
    expect((await fetchUi(`${path}/close`, { method: "POST", ...withCookie(`${path}/close`, fixture.outCookie) })).status).toBe(404);
    expect(
      (await fetchUi(`${path}/columns/new`, { method: "POST", ...withCookie(`${path}/columns/new`, fixture.outCookie) })).status,
    ).toBe(404);
  });

  it("even a SITE ADMIN is a NotFound on another user's project writes (web.go:1151-1155)", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    // The read ladder admits the admin (200 on the board), the write group
    // does not.
    expect((await fetchUi(path, withCookie(path, fixture.adminCookie))).status).toBe(200);
    expect((await fetchUi(`${path}/edit`, withCookie(`${path}/edit`, fixture.adminCookie))).status).toBe(404);
    expect((await fetchUi(`${path}/delete`, { method: "POST", ...withCookie(`${path}/delete`, fixture.adminCookie) })).status).toBe(404);
  });

  it("the POST-only tails answer GET with the 405 (chi's method mismatch)", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    expect((await fetchUi(`${path}/delete`, withCookie(`${path}/delete`, fixture.ownerCookie))).status).toBe(405);
    expect((await fetchUi(`${path}/columns/new`, withCookie(`${path}/columns/new`, fixture.ownerCookie))).status).toBe(405);
    expect((await fetchUi(`${path}/9/default`, withCookie(`${path}/9/default`, fixture.ownerCookie))).status).toBe(405);
  });
});

// --- the project write forms -------------------------------------------------------

describe("project write forms", () => {
  it("creates a project through POST /new (the template seeds the columns) and 303s to the list", async () => {
    const fixture = await ensureWave40Fixtures();
    const res = await fetchUi(
      "/wave40-user/-/projects/new",
      formPost("/wave40-user/-/projects/new", fixture.ownerCookie, {
        title: "Formed Board",
        content: "from the *form*",
        template_type: "basic_kanban",
        card_type: "text_only",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave40-user/-/projects");
    // The list shows it and the title anchors the board (the wave-37
    // title-link hunk).
    const list = await (await fetchUi("/wave40-user/-/projects", withCookie("/wave40-user/-/projects", fixture.ownerCookie))).text();
    expect(list).toContain("Formed Board");
    const boardHref = /href="(\/wave40-user\/-\/projects\/\d+)"/.exec(list)?.[1];
    expect(boardHref).toBeDefined();
    // The new board carries the template's columns.
    const board = await (await fetchUi(boardHref as string, withCookie(boardHref as string, fixture.ownerCookie))).text();
    for (const title of ["Backlog", "To Do", "In Progress", "Done"]) {
      expect(board).toContain(title);
    }
  });

  it("re-renders the new form at 200 with the binding error and the kept title", async () => {
    const fixture = await ensureWave40Fixtures();
    const res = await fetchUi(
      "/wave40-user/-/projects/new",
      formPost("/wave40-user/-/projects/new", fixture.ownerCookie, { title: "", content: "kept" }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A title is required.");
    expect(html).toContain("kept");
    const tooLong = await fetchUi(
      "/wave40-user/-/projects/new",
      formPost("/wave40-user/-/projects/new", fixture.ownerCookie, { title: "x".repeat(101) }),
    );
    expect(tooLong.status).toBe(200);
    expect(await tooLong.text()).toContain("Title is too long.");
  });

  it("edits through POST /{id}/edit with redirect=project landing on the board", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    const res = await fetchUi(
      `${path}/edit`,
      formPost(`${path}/edit`, fixture.ownerCookie, {
        title: "Feature Board v2",
        content: "updated description",
        card_type: "text_only",
        redirect: "project",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(path);
    const board = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(board).toContain("Feature Board v2");
    // Without the redirect field the edit lands on the LIST.
    const res2 = await fetchUi(
      `${path}/edit`,
      formPost(`${path}/edit`, fixture.ownerCookie, { title: "Feature Board v3", content: "", card_type: "text_only" }),
    );
    expect(res2.status).toBe(303);
    expect(res2.headers.get("location")).toBe("/wave40-user/-/projects");
  });

  it("closes and reopens through the status POSTs (the guarded flip)", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    const close = await fetchUi(`${path}/close`, { method: "POST", ...withCookie(`${path}/close`, fixture.ownerCookie) });
    expect(close.status).toBe(303);
    expect(close.headers.get("location")).toBe(path);
    // The board now offers Open; the list's default facet hides it.
    const board = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(board).toContain(`${path}/open`);
    const list = await (await fetchUi("/wave40-user/-/projects", withCookie("/wave40-user/-/projects", fixture.ownerCookie))).text();
    expect(list).not.toContain("Feature Board v3");
    const closedList = await (
      await fetchUi("/wave40-user/-/projects?state=closed", withCookie("/wave40-user/-/projects?state=closed", fixture.ownerCookie))
    ).text();
    expect(closedList).toContain("Feature Board v3");
    // Reopen.
    const reopen = await fetchUi(`${path}/open`, { method: "POST", ...withCookie(`${path}/open`, fixture.ownerCookie) });
    expect(reopen.status).toBe(303);
    const board2 = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(board2).toContain(`${path}/close`);
  });

  it("deletes through POST /{id}/delete and the board 404-shells after", async () => {
    const fixture = await ensureWave40Fixtures();
    // A throwaway board.
    const created = await createProject(env.DB, userProjectScope(fixture.ownerId), {
      title: "Doomed Board",
      description: "",
      creatorId: fixture.ownerId,
      now: NOW,
    });
    const path = `/wave40-user/-/projects/${created.id}`;
    const res = await fetchUi(`${path}/delete`, { method: "POST", ...withCookie(`${path}/delete`, fixture.ownerCookie) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave40-user/-/projects");
    expect((await fetchUi(path, withCookie(path, fixture.ownerCookie))).status).toBe(404);
  });
});

// --- the column writes -------------------------------------------------------------

describe("column writes", () => {
  it("creates a column through POST /{id}/columns/new (upstream's form-bind route)", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    const res = await fetchUi(
      `${path}/columns/new`,
      formPost(`${path}/columns/new`, fixture.ownerCookie, { title: "Review", color: "#00aabb" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(path);
    const board = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(board).toContain("Review");
  });

  it("re-renders the board with the exact color 422 and the kept values", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    const res = await fetchUi(
      `${path}/columns/new`,
      formPost(`${path}/columns/new`, fixture.ownerCookie, { title: "Bad Color", color: "nothex" }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("invalid column color");
    expect(html).toContain("Bad Color");
    expect(html).toContain('value="nothex"');
  });

  it("moves the default flag through POST /{id}/{columnID}/default", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    const columns = (await listColumns(env.DB, fixture.boardId, 1, 100)).items;
    const todo = columns.find((column) => column.title === "To Do");
    if (todo === undefined) throw new Error("To Do missing");
    const res = await fetchUi(`${path}/${todo.id}/default`, {
      method: "POST",
      ...withCookie(`${path}/${todo.id}/default`, fixture.ownerCookie),
    });
    expect(res.status).toBe(303);
    const board = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    // The default hint moved with the flag (the title attribute renders on
    // the default column's title text).
    expect(board).toContain("New issues added to this project will be added to this column");
    // A foreign column id 404-shells.
    const foreign = await fetchUi(`${path}/999999/default`, {
      method: "POST",
      ...withCookie(`${path}/999999/default`, fixture.ownerCookie),
    });
    expect(foreign.status).toBe(404);
  });
});

// --- the org arm's gates -----------------------------------------------------------

describe("org board gates", () => {
  it("a projects-unit writer who is not the org owner sees board writes but no workflow manage arms", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40org/-/projects/${fixture.orgBoardId}`;
    const board = await (await fetchUi(path, withCookie(path, fixture.orgWriterCookie))).text();
    expect(board).toContain("New Column");
    const workflows = await (await fetchUi(`${path}/workflows`, withCookie(`${path}/workflows`, fixture.orgWriterCookie))).text();
    expect(workflows).toContain("Workflows act on their items");
    expect(workflows).not.toContain("New workflow");
    // The manage gate 404-shells the write.
    const create = await fetchUi(
      `${path}/workflows`,
      formPost(`${path}/workflows`, fixture.orgWriterCookie, { event: "item_added_to_project", enabled: "true" }),
    );
    expect(create.status).toBe(404);
  });

  it("the org owner manages workflows through the form-POST contract", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40org/-/projects/${fixture.orgBoardId}`;
    const create = await fetchUi(
      `${path}/workflows`,
      formPost(`${path}/workflows`, fixture.orgOwnerCookie, {
        event: "item_added_to_project",
        enabled: "true",
        filter_issue_type: "issue",
        action_issue_state: "close",
      }),
    );
    expect(create.status).toBe(303);
    const page = await (await fetchUi(`${path}/workflows`, withCookie(`${path}/workflows`, fixture.orgOwnerCookie))).text();
    expect(page).toContain("Item added to project");
    expect(page).toContain("Issues only");
    expect(page).toContain("Close issue");
    // The unknown-event 422 re-renders with the service's exact text.
    const badEvent = await fetchUi(
      `${path}/workflows`,
      formPost(`${path}/workflows`, fixture.orgOwnerCookie, { event: "not_an_event" }),
    );
    expect(badEvent.status).toBe(200);
    expect(await badEvent.text()).toContain("invalid event: not_an_event");
    // The unsupported action for the event hits the capability 422.
    const badAction = await fetchUi(
      `${path}/workflows`,
      formPost(`${path}/workflows`, fixture.orgOwnerCookie, { event: "item_reopened", action_issue_state: "close" }),
    );
    expect(badAction.status).toBe(200);
    expect(await badAction.text()).toContain("issue_state is not supported by this event");
  });

  it("the enable/disable toggle keeps the stored rules; the full POST replaces them; delete removes", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40org/-/projects/${fixture.orgBoardId}`;
    let page = await (await fetchUi(`${path}/workflows`, withCookie(`${path}/workflows`, fixture.orgOwnerCookie))).text();
    const wid = Number(/\/workflows\/(\d+)"/.exec(page)![1]);
    // The toggle POST (enabled only — the replace-vs-toggle contract).
    const toggle = await fetchUi(
      `${path}/workflows/${wid}`,
      formPost(`${path}/workflows/${wid}`, fixture.orgOwnerCookie, { enabled: "false" }),
    );
    expect(toggle.status).toBe(303);
    page = await (await fetchUi(`${path}/workflows`, withCookie(`${path}/workflows`, fixture.orgOwnerCookie))).text();
    expect(page).toContain("Disabled");
    expect(page).toContain("Issues only"); // the stored filter survived the toggle
    // The focused edit form (the /workflows/{wid} PATH tail — upstream's
    // route form) renders pre-filled.
    const focused = await (
      await fetchUi(`${path}/workflows/${wid}`, withCookie(`${path}/workflows/${wid}`, fixture.orgOwnerCookie))
    ).text();
    expect(focused).toContain("Edit workflow");
    expect(focused).toContain('value="issue" selected');
    // An unknown wid PATH tail 404-shells (RenderWorkflows' arm).
    expect(
      (
        await fetchUi(
          `${path}/workflows/999999`,
          withCookie(`${path}/workflows/999999`, fixture.orgOwnerCookie),
        )
      ).status,
    ).toBe(404);
    // An unknown ?event= 404-shells (RenderWorkflows' workflow.go:48-52 arm).
    expect(
      (await fetchUi(`${path}/workflows?event=bogus`, withCookie(`${path}/workflows?event=bogus`, fixture.orgOwnerCookie))).status,
    ).toBe(404);
    // The full-rule replace: swap the action to a move-to-column.
    const columns = (await listColumns(env.DB, fixture.orgBoardId, 1, 100)).items;
    const firstColumn = columns[0]!;
    const replace = await fetchUi(
      `${path}/workflows/${wid}`,
      formPost(`${path}/workflows/${wid}`, fixture.orgOwnerCookie, {
        event: "item_added_to_project",
        enabled: "true",
        filter_issue_type: "",
        action_column_id: String(firstColumn.id),
      }),
    );
    expect(replace.status).toBe(303);
    page = await (await fetchUi(`${path}/workflows`, withCookie(`${path}/workflows`, fixture.orgOwnerCookie))).text();
    expect(page).toContain(`Move to column ${firstColumn.title}`);
    // The delete POST removes the workflow (the empty arm renders; the
    // create form's Disabled option stays, so probe the row's form action).
    const del = await fetchUi(`${path}/workflows/${wid}/delete`, {
      method: "POST",
      ...withCookie(`${path}/workflows/${wid}/delete`, fixture.orgOwnerCookie),
    });
    expect(del.status).toBe(303);
    page = await (await fetchUi(`${path}/workflows`, withCookie(`${path}/workflows`, fixture.orgOwnerCookie))).text();
    expect(page).not.toContain(`/workflows/${wid}/delete`);
  });

  it("a user-project's owner manages its workflows (the individual CanManage arm)", async () => {
    const fixture = await ensureWave40Fixtures();
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    // At least one action is required (the service's exact 422 otherwise).
    const create = await fetchUi(
      `${path}/workflows`,
      formPost(`${path}/workflows`, fixture.ownerCookie, {
        event: "item_column_changed",
        enabled: "true",
        action_issue_state: "close",
      }),
    );
    expect(create.status).toBe(303);
    const page = await (await fetchUi(`${path}/workflows`, withCookie(`${path}/workflows`, fixture.ownerCookie))).text();
    expect(page).toContain("Item column changed");
    // The action-less create re-renders with the service's exact 422.
    const noAction = await fetchUi(
      `${path}/workflows`,
      formPost(`${path}/workflows`, fixture.ownerCookie, { event: "item_column_changed", enabled: "true" }),
    );
    expect(noAction.status).toBe(200);
    expect(await noAction.text()).toContain("at least one action must be configured");
    // The admin is NOT the manager of a user project's workflows (owner
    // equality without the org arm's admin short-circuit).
    const adminCreate = await fetchUi(
      `${path}/workflows`,
      formPost(`${path}/workflows`, fixture.adminCookie, { event: "item_closed", enabled: "true", action_issue_state: "close" }),
    );
    expect(adminCreate.status).toBe(404);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-40 a11y smoke", () => {
  it("the new renders pass the structural rules", async () => {
    const fixture = await ensureWave40Fixtures();
    for (const [path, init] of [
      [`/wave40-user/-/projects/${fixture.boardId}`, undefined],
      [`/wave40-user/-/projects/${fixture.boardId}`, withCookie(`/wave40-user/-/projects/${fixture.boardId}`, fixture.ownerCookie)],
      [
        `/wave40-user/-/projects/${fixture.boardId}/workflows`,
        withCookie(`/wave40-user/-/projects/${fixture.boardId}/workflows`, fixture.ownerCookie),
      ],
      [`/wave40-user/-/projects/new`, withCookie(`/wave40-user/-/projects/new`, fixture.ownerCookie)],
      [
        `/wave40-user/-/projects/${fixture.boardId}/edit`,
        withCookie(`/wave40-user/-/projects/${fixture.boardId}/edit`, fixture.ownerCookie),
      ],
      [`/wave40org/-/projects/${fixture.orgBoardId}`, undefined],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});

// --- wave-129 batch 9: the owner board's ordering, card-anatomy and move-reduction arms ---

/** The batch-9 owner-board fixtures: two appended columns, a task-list issue,
 *  an open PR card and the PR cross-reference comment — each created only
 *  when absent (the fixture cache reuses them across re-runs). */
async function ensureOwnerBoardAnatomyFixtures(fixture: Wave40Fixture): Promise<{ prIndex: number }> {
  const ownerId = fixture.ownerId;
  const pubRows = await db().select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, fixture.pubRepoSlug)).all();
  const pubId = pubRows[0]?.id;
  if (pubId === undefined) throw new Error("wave40-pub repo row missing");

  // The appended columns (createColumn sorts them after the template's —
  // `min(max(sorting)+1, 127)`), id-tie-broken by `sorting, id` order.
  const columnsNow = await listColumns(env.DB, fixture.boardId, 1, 100);
  const have = new Set(columnsNow.items.map((column) => column.title));
  if (!have.has("Owner Queue 129")) {
    await createColumn(env.DB, fixture.boardId, { title: "Owner Queue 129", color: "", creatorId: ownerId, now: NOW });
  }
  if (!have.has("Owner Overflow 129")) {
    await createColumn(env.DB, fixture.boardId, { title: "Owner Overflow 129", color: "", creatorId: ownerId, now: NOW });
  }

  const service = new IssuesService(env.DB);
  const existing = await db()
    .select({ id: issues.id, index: issues.index, title: issues.title })
    .from(issues)
    .where(eq(issues.repoId, pubId))
    .all();
  const byTitle = new Map(existing.map((row) => [row.title, row]));

  // The task-counter issue: `- [x]`/`- [ ]` list items (issueTasksPat).
  let tasks = byTitle.get("Owner board issue 9 (tasks)");
  if (tasks === undefined) {
    const rows = await db()
      .insert(issues)
      .values({
        repoId: pubId,
        index: 9,
        title: "Owner board issue 9 (tasks)",
        content: "- [x] shipped thing\n- [ ] open thing\n",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning()
      .all();
    tasks = rows[0];
  }
  if (tasks === undefined) throw new Error("owner task issue seed failed");

  // The shared per-repo index counter (repoCounters.issue_index — §3.1) sits
  // below the fixture's DIRECT seedIssue inserts; pin it to their max before
  // the PR create draws from it.
  await db()
    .insert(repoCounters)
    .values({ repoId: pubId, issueIndex: 9 })
    .onConflictDoUpdate({ target: repoCounters.repoId, set: { issueIndex: sql`max(issue_index, 9)` } });

  // The open PR card: a real issues+pullRequests pair through the landed
  // service (isPull flips the title link onto pulls/{index}).
  let pr = byTitle.get("Owner board PR card");
  if (pr === undefined) {
    const created = await service.createPullRequest({
      repoId: pubId,
      headRepoId: pubId,
      baseBranch: "main",
      headBranch: "owner-pr-card-branch",
      title: "Owner board PR card",
      posterId: ownerId,
      now: NOW,
    });
    pr = { id: created.issue.id, index: created.issue.index, title: created.issue.title };
  }
  if (pr === undefined) throw new Error("owner pr card seed failed");

  // The linked-PR row: a type-3 cross-reference comment refIsPull onto the PR
  // (ViewProject's linkedPrsMap walk reads comments.refIssueId+refIsPull).
  const refRows = await db().select({ id: comments.id }).from(comments).where(eq(comments.refIssueId, pr.id)).all();
  if (refRows.length === 0) {
    await db().insert(comments).values({
      type: 3, // the cross-reference comment family (§2.2's ref types)
      posterId: ownerId,
      issueId: tasks.id,
      refRepoId: pubId,
      refIssueId: pr.id,
      refIsPull: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  // Both cards into the first appended column (the claim guard keeps the
  // re-run a no-op — addIssueToColumn moves as well as adds).
  const project = await findProjectById(env.DB, userProjectScope(ownerId), fixture.boardId);
  if (project === null) throw new Error("owner board project row missing");
  const claimedIds = new Set(
    (await db().select({ issueId: projectIssues.issueId }).from(projectIssues).all()).map((row) => row.issueId),
  );
  const columnsAfter = await listColumns(env.DB, fixture.boardId, 1, 100);
  const queue = columnsAfter.items.find((column) => column.title === "Owner Queue 129");
  if (queue === undefined) throw new Error("Owner Queue 129 column missing");
  const tasksRow = (await db().select().from(issues).where(eq(issues.id, tasks.id)).get())!;
  const prRow = (await db().select().from(issues).where(eq(issues.id, pr.id)).get())!;
  if (!claimedIds.has(tasksRow.id)) await addIssueToColumn(env.DB, project, tasksRow, queue, ownerId, NOW);
  if (!claimedIds.has(prRow.id)) await addIssueToColumn(env.DB, project, prRow, queue, ownerId, NOW);

  return { prIndex: prRow.index };
}

describe("owner board ordering + card anatomy (wave-129 batch 9)", () => {
  it("orders columns by sorting then id — appended columns render after the template's four, the default star on Backlog", async () => {
    const fixture = await ensureWave40Fixtures();
    await ensureOwnerBoardAnatomyFixtures(fixture);
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    const html = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    // The column walk is `sorting, id` (column_list.go:20): the template's
    // four columns carry sorting 0 (insertion order), the appended two sort
    // after them.
    const order = ["Backlog", "To Do", "In Progress", "Done", "Owner Queue 129", "Owner Overflow 129"].map((title) => html.indexOf(title));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The default column's star glyph and its tooltip hint (view.tmpl's
    // default_column arm).
    expect(html).toContain("octicon-star");
    expect(html).toContain("New issues added to this project will be added to this column");
    // The cards keep the project-column-sorting insertion order within the
    // appended column.
    expect(html.indexOf("Owner board issue 9 (tasks)")).toBeLessThan(html.indexOf("Owner board PR card"));
  });

  it("renders the card anatomy: the PR title link + glyph, the task counter, the event labels, the assignee strip, the linked PR", async () => {
    const fixture = await ensureWave40Fixtures();
    const { prIndex } = await ensureOwnerBoardAnatomyFixtures(fixture);
    const path = `/wave40-user/-/projects/${fixture.boardId}`;
    const html = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();

    // The PR card: the title link rides Issue.Link's pulls/{index} arm and
    // the open-PR glyph (IssueStateIcon's green git-pull-request).
    expect(html).toContain(`href="/wave40-user/${fixture.pubRepoSlug}/pulls/${prIndex}"`);
    expect(html).toContain("octicon-git-pull-request");
    // The task counter (issueTasksPat over `- [x] a` + `- [ ] b`).
    expect(html).toContain("octicon-checklist");
    expect(html).toContain("1 / 2");
    // The event labels: the open cards' "opened … by" arm and the closed
    // Done card's "was closed" arm (GetLastEventLabel's reduced pair).
    expect(html).toContain("opened");
    expect(html).toContain("was closed");
    // The assignee bottom strip (octicon-person + the plain username;
    // pubIssue1's assignee from the shared fixture).
    expect(html).toContain("octicon-person");
    expect(html).toContain("wave40-user");
    // The linked-PR row: the cross-reference comment's PR renders under the
    // ref with its state-colored git-merge glyph (green = open).
    expect(html).toContain("octicon-git-merge");
    expect(html).toContain("Owner board PR card");
  });

  it("keeps the drag-drop move writes unclaimed at the HTTP surface (the no-JS reduction)", async () => {
    const fixture = await ensureWave40Fixtures();
    // The module header's reduction: POST /move (MoveColumns) and
    // POST /{columnID}/move (MoveIssues) are sortablejs JSON fetches with no
    // no-JS control upstream either — the shapes stay unclaimed, so the
    // mounted router answers the engine's plain 404.
    const move = await fetchUi(`/wave40-user/-/projects/${fixture.boardId}/move`, { method: "POST" });
    expect(move.status).toBe(404);
    const cardMove = await fetchUi(`/wave40-user/-/projects/${fixture.boardId}/9/move`, { method: "POST" });
    expect(cardMove.status).toBe(404);
    expect(handlesUiRoute(`/wave40-user/-/projects/${fixture.boardId}/move`)).toBe(false);
  });
});
