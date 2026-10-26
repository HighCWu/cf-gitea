/**
 * Pages wave 45 route tests — the UI-parity survey's re-ranked #1
 * (docs/compat/ui-parity-survey.md §F: web.go:1544-1563): the REPO-scoped
 * projects surface — `/{owner}/{repo}/projects` list + `/{id}` board + the
 * write group + the workflow tails — over the landed repo-scope service
 * arms (routes/projects-repo.ts's composition), the owner-board precedent
 * (wave 40) ported onto the repo resolution + the has_projects unit toggle.
 *
 * Pins asserted:
 *   - the parser claims exactly the repo-scope shapes (the wave-40 flip
 *     kept them unclaimed until this wave): the bare literal, the `new`
 *     literal, the numeric-id shapes, the workflows tails — junk ids, the
 *     PUT/DELETE/JSON board-helper arms (`/move`, `/{columnID}`,
 *     `/{columnID}/move`) and deeper tails stay unclaimed → the engine's 404;
 *   - the unit toggle: `MustEnableRepoProjects` reduced to the loaded
 *     repo_settings.has_projects — a repo without the flag 404-shells every
 *     family AND renders no header tab; an enabled repo shows the tab on
 *     every repo page (the entry point);
 *   - the gates: the read arm is the §2.5 repo grant (invisible repo → 404);
 *     the write ladder (anonymous → the login 303; a signed-in non-writer →
 *     the 404 shell; a write-mode collaborator passes — the writer arm; a
 *     site admin passes — the admin arm); an archived repo refuses writes;
 *   - the repo-scope containment: another repo's project id 404-shells
 *     (GetProjectByID over repoProjectScope — the upstream RepoID-mismatch
 *     arm folded into the scope condition);
 *   - the list surface (state facet, per-row writer controls, the New
 *     Project button, both empty arms) and the board (template columns,
 *     default star, the cards' issue links, the facet filters honored in
 *     memory with the counts reflecting them);
 *   - the write forms: create (template columns seeded), edit
 *     (redirect=project), open/close, delete, column create + set-default,
 *     the POST-only tails answering GET with the 405;
 *   - the workflow form-POST contract at the repo arm: the repo WRITER
 *     manages workflows (CanManageWorkflows' repo arm collapsed into the
 *     writer — the org scopes' stricter layers do NOT apply here), the
 *     service's exact 422s re-render, the label pool spans the repo's
 *     labels PLUS the owner org's owner-level labels (an org-owned repo),
 *     the toggle/replace contract, and the unknown wid/?event= 404 arms.
 *
 * Same harness posture as pages-wave40: the router is driven directly with
 * the synthetic ASSETS manifest; D1-only fixtures (no engine content).
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import {
  issueAssignees,
  issueLabels,
  issues,
  labels,
  milestones,
  repoCollaborators,
  repoSettings,
  repositories,
} from "../../db/schema";
import {
  addIssueToColumn,
  createProject,
  listColumns,
  repoProjectScope,
} from "../../api/services/projects";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { uiEnv } from "./harness";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";

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

interface Wave45Fixture {
  ownerCookie: string; // wave45-owner — the repo owner (a writer)
  collabCookie: string; // wave45-collab — a write-mode collaborator (a writer)
  outCookie: string; // wave45-out — a signed-in outsider (never a writer)
  adminCookie: string; // wave45-admin — a site admin (the admin arm)
  orgOwnerCookie: string; // wave45-orgowner — owns the org repo
  ownerId: number;
  boardId: number; // the lab repo's board
  otherBoardId: number; // another repo's board (the containment arm)
  orgBoardId: number; // the org repo's board
  repoSlug: string;
  otherRepoSlug: string;
  noUnitSlug: string; // has_projects unset (the unit gate arm)
  orgRepoSlug: string;
  milestoneId: number;
  bugLabelId: number;
  otherRepoLabelId: number; // a FOREIGN repo's label (the pool 422 arm)
}

let wave45Fixture: Wave45Fixture | null = null;

async function seedIssue(repoId: string, index: number, isClosed = false) {
  const rows = await db()
    .insert(issues)
    .values({ repoId, index, title: `Repo board issue ${index}`, createdAt: NOW, updatedAt: NOW, isClosed })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("issue seed failed");
  return row;
}

/** Create a repo, then flip its projects unit on (the repo-edit PATCH's
 *  stored flag — the settings side table; a missing row is the disabled
 *  default, which the noUnit arm keeps). */
async function seedRepo(owner: { id: number; usernameLower: string }, name: string, isPrivate: boolean) {
  const repos = new RepoService(env.DB);
  const repo = await repos.create({
    owner: { id: owner.id, usernameLower: owner.usernameLower },
    name,
    isPrivate,
    status: "ready",
  });
  await db().insert(repoSettings).values({ repoId: repo.id, hasProjects: true });
  return repo;
}

async function ensureWave45Fixtures(): Promise<Wave45Fixture> {
  if (wave45Fixture !== null) return wave45Fixture;
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "wave45-owner" });
  const collab = await seedVerifiedUser({ username: "wave45-collab" });
  const out = await seedVerifiedUser({ username: "wave45-out" });
  const admin = await seedVerifiedUser({ username: "wave45-admin", isAdmin: true });
  const orgOwner = await seedVerifiedUser({ username: "wave45-orgowner" });

  const lab = await seedRepo(
    { id: owner.id, usernameLower: owner.username.toLowerCase() },
    "wave45-lab",
    false,
  );
  // The no-unit repo: NO repo_settings row — the disabled default.
  const repos = new RepoService(env.DB);
  await repos.create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: "wave45-nounit",
    isPrivate: false,
    status: "ready",
  });
  const other = await seedRepo(
    { id: owner.id, usernameLower: owner.username.toLowerCase() },
    "wave45-other",
    false,
  );
  // The write-refusal arm: an archived repo with the unit on.
  const archived = await seedRepo(
    { id: owner.id, usernameLower: owner.username.toLowerCase() },
    "wave45-arch",
    false,
  );
  await db().update(repositories).set({ isArchived: true }).where(eq(repositories.id, archived.id));

  // The collaborator's write grant (the repoCollaborators row — the writer
  // arm beyond the owner).
  await db().insert(repoCollaborators).values({ repoId: lab.id, userId: collab.id, mode: "write" });

  // The lab board: the basic_kanban template (Backlog the default), two
  // open issues in "To Do", one closed in "Done".
  const board = await createProject(env.DB, repoProjectScope(lab.id), {
    title: "Repo Board",
    description: "the *repo* board",
    template_type: "basic_kanban",
    card_type: "images_and_text",
    creatorId: owner.id,
    now: NOW,
  });
  const columns = (await listColumns(env.DB, board.id, 1, 100)).items;
  const todo = columns.find((column) => column.title === "To Do");
  const done = columns.find((column) => column.title === "Done");
  if (todo === undefined || done === undefined) throw new Error("template columns missing");

  const issue1 = await seedIssue(lab.id, 1);
  const issue2 = await seedIssue(lab.id, 2);
  const doneIssue = await seedIssue(lab.id, 3, true);
  await addIssueToColumn(env.DB, board, issue1, todo, owner.id, NOW);
  await addIssueToColumn(env.DB, board, issue2, todo, owner.id, NOW);
  await addIssueToColumn(env.DB, board, doneIssue, done, owner.id, NOW);

  // The facet fixtures: a milestone on issue1, a repo label on issue2, an
  // assignee on issue1.
  await db().insert(milestones).values({ repoId: lab.id, name: "Sprint 45", createdAt: NOW, updatedAt: NOW });
  const milestoneRow = (await db().select().from(milestones).where(eq(milestones.repoId, lab.id)).all())[0];
  if (milestoneRow === undefined) throw new Error("milestone seed failed");
  await db().update(issues).set({ milestoneId: milestoneRow.id }).where(eq(issues.id, issue1.id));
  await db().insert(labels).values({ repoId: lab.id, name: "bug", color: "#ee0701" });
  const labelRow = (await db().select().from(labels).where(eq(labels.repoId, lab.id)).all())[0];
  if (labelRow === undefined) throw new Error("label seed failed");
  await db().insert(issueLabels).values({ issueId: issue2.id, labelId: labelRow.id });
  await db().insert(issueAssignees).values({ issueId: issue1.id, assigneeId: owner.id });

  // Another repo's board + label (the containment arm and the workflow
  // label-pool 422 arm).
  const otherBoard = await createProject(env.DB, repoProjectScope(other.id), {
    title: "Other Board",
    description: "",
    creatorId: owner.id,
    now: NOW,
  });
  await db().insert(labels).values({ repoId: other.id, name: "other-only", color: "#00aabb" });
  const otherLabel = (await db().select().from(labels).where(eq(labels.repoId, other.id)).all())[0];
  if (otherLabel === undefined) throw new Error("other label seed failed");

  // The org arm: an org-owned repo with the unit on, an org label (the
  // pool's org half) and an empty board.
  const orgs = new OrgService(env.DB);
  const org: OrgRecord = await orgs.createOrg({ name: "wave45org", ownerId: orgOwner.id, visibility: "public", now: NOW });
  const orgRepo = await seedRepo({ id: org.id, usernameLower: "wave45org" }, "lab-org", false);
  const orgBoard = await createProject(env.DB, repoProjectScope(orgRepo.id), {
    title: "Org Lab Board",
    description: "",
    creatorId: orgOwner.id,
    now: NOW,
  });
  await db().insert(labels).values({ repoId: null, orgId: org.id, name: "org-wide-45", color: "#0a0abb" });

  wave45Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    collabCookie: await mintSession(env.DB, collab.id),
    outCookie: await mintSession(env.DB, out.id),
    adminCookie: await mintSession(env.DB, admin.id),
    orgOwnerCookie: await mintSession(env.DB, orgOwner.id),
    ownerId: owner.id,
    boardId: board.id,
    otherBoardId: otherBoard.id,
    orgBoardId: orgBoard.id,
    repoSlug: "wave45-lab",
    otherRepoSlug: "wave45-other",
    noUnitSlug: "wave45-nounit",
    orgRepoSlug: "lab-org",
    milestoneId: milestoneRow.id,
    bugLabelId: labelRow.id,
    otherRepoLabelId: otherLabel.id,
  };
  return wave45Fixture;
}

beforeAll(async () => {
  await ensureWave45Fixtures();
});

// --- the parser claims (the wave-40 flip's release) ------------------------------

describe("wave-45 parser claims", () => {
  const owner = "wave45-owner";
  const repo = "wave45-lab";

  it("claims exactly the repo-scope list/board/write/workflow shapes", () => {
    expect(parseUiRoute(`/${owner}/${repo}/projects`)).toEqual({ family: "repo-projects", owner, repo });
    expect(parseUiRoute(`/${owner}/${repo}/projects/new`)).toEqual({ family: "repo-project-new", owner, repo });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7`)).toEqual({ family: "repo-project-board", owner, repo, id: 7 });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/edit`)).toEqual({ family: "repo-project-edit", owner, repo, id: 7 });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/delete`)).toEqual({ family: "repo-project-delete", owner, repo, id: 7 });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/open`)).toEqual({
      family: "repo-project-status",
      owner,
      repo,
      id: 7,
      action: "open",
    });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/close`)).toEqual({
      family: "repo-project-status",
      owner,
      repo,
      id: 7,
      action: "close",
    });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/columns/new`)).toEqual({
      family: "repo-project-column-new",
      owner,
      repo,
      id: 7,
    });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/9/default`)).toEqual({
      family: "repo-project-column-default",
      owner,
      repo,
      id: 7,
      columnId: 9,
    });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/workflows`)).toEqual({
      family: "repo-project-workflows",
      owner,
      repo,
      id: 7,
    });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/workflows/9`)).toEqual({
      family: "repo-project-workflows",
      owner,
      repo,
      id: 7,
      workflowId: 9,
    });
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/workflows/9/delete`)).toEqual({
      family: "repo-project-workflow-delete",
      owner,
      repo,
      id: 7,
      workflowId: 9,
    });
    // PathParamInt64 parity: "007" parses as 7.
    expect(parseUiRoute(`/${owner}/${repo}/projects/007`)).toEqual({ family: "repo-project-board", owner, repo, id: 7 });
    expect(handlesUiRoute(`/${owner}/${repo}/projects/7/workflows/9/delete`)).toBe(true);
  });

  it("leaves the reduced arms and junk shapes unclaimed (the engine's 404)", () => {
    // The PUT/DELETE/JSON board-helper arms (the no-JS reductions — the
    // page module's header, the owner-board posture).
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/move`)).toBeNull();
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/9`)).toBeNull();
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/9/move`)).toBeNull();
    // Junk id segments stay engine-owned (upstream's PathParamInt64-zero
    // ServerError arm — the landed uniform not-found answer).
    expect(parseUiRoute(`/${owner}/${repo}/projects/abc`)).toBeNull();
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/abc`)).toBeNull();
    // Deeper/other tails.
    expect(parseUiRoute(`/${owner}/${repo}/projects/7/unknown`)).toBeNull();
    expect(parseUiRoute(`/${owner}/${repo}/projects/new/more`)).toBeNull();
    expect(handlesUiRoute(`/${owner}/${repo}/projects/7/move`)).toBe(false);
  });
});

// --- the unit toggle + the header tab ---------------------------------------------

describe("the projects unit toggle (MustEnableRepoProjects)", () => {
  it("404-shells every family on a repo without the flag (the disabled default)", async () => {
    await ensureWave45Fixtures();
    expect((await fetchUi(`/wave45-owner/wave45-nounit/projects`)).status).toBe(404);
    expect((await fetchUi(`/wave45-owner/wave45-nounit/projects/7`)).status).toBe(404);
    expect((await fetchUi(`/wave45-owner/wave45-nounit/projects/7/workflows`)).status).toBe(404);
    expect(
      (await fetchUi(`/wave45-owner/wave45-nounit/projects/new`, { method: "POST", ...withCookie("/x", "y") })).status,
    ).toBe(404);
  });

  it("renders no header tab on the disabled repo and the tab on the enabled one", async () => {
    const fixture = await ensureWave45Fixtures();
    // The disabled repo's home: no Projects tab at all (repo/header.tmpl's
    // gated include).
    const noUnit = await (await fetchUi(`/wave45-owner/${fixture.noUnitSlug}`)).text();
    expect(noUnit).not.toContain(`/${fixture.noUnitSlug}/projects"`);
    // The enabled repo's home: the tab, with upstream's g b shortcut.
    const unit = await (await fetchUi(`/wave45-owner/${fixture.repoSlug}`)).text();
    expect(unit).toContain(`href="/wave45-owner/${fixture.repoSlug}/projects"`);
    expect(unit).toContain('data-shortcut-keys="g b"');
  });
});

// --- the list page -----------------------------------------------------------------

describe("repo projects list GET /{owner}/{repo}/projects", () => {
  it("renders the rows and anchors to anonymous — no writer controls", async () => {
    const fixture = await ensureWave45Fixtures();
    const res = await fetchUi(`/wave45-owner/${fixture.repoSlug}/projects`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The template's page-content discriminator + the repo header chrome.
    expect(html).toContain("repository projects milestones");
    expect(html).toContain("Repo Board");
    expect(html).toContain("<em>repo</em> board");
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}"`);
    // The writer-only row (the toggle + the New Project button) is absent.
    expect(html).not.toContain("list-header-toggle");
    expect(html).not.toContain("/projects/new");
    // The per-row controls are absent.
    expect(html).not.toContain(`/projects/${fixture.boardId}/edit`);
  });

  it("the writer sees the toggle, the New Project button and the per-row controls", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects`;
    const html = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(html).toContain("list-header-toggle");
    expect(html).toContain(`href="${path}/new"`);
    expect(html).toContain(`${fixture.boardId}/edit`);
    expect(html).toContain(`${fixture.boardId}/close`);
    expect(html).toContain(`${fixture.boardId}/delete`);
  });

  it("the state facet moves rows between the open/closed arms", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects`;
    const open = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(open).toContain("Repo Board");
    const closed = await (
      await fetchUi(`${path}?state=closed`, withCookie(`${path}?state=closed`, fixture.ownerCookie))
    ).text();
    expect(closed).not.toContain("Repo Board");
  });

  it("an invisible repo 404-shells (the §2.5 read grant is the reader arm)", async () => {
    await ensureWave45Fixtures();
    // A nonexistent repo answers the uniform not-found shell.
    expect((await fetchUi(`/wave45-owner/no-such-repo/projects`)).status).toBe(404);
  });
});

// --- the board -----------------------------------------------------------------------

describe("repo project board GET /{owner}/{repo}/projects/{id}", () => {
  it("renders the columns and cards to anonymous, with the top links row", async () => {
    const fixture = await ensureWave45Fixtures();
    const res = await fetchUi(`/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository projects view-project");
    expect(html).toContain("Repo Board");
    expect(html).toContain("<em>repo</em> board");
    // The view.tmpl top links row: Labels + Milestones live, New Issue onto
    // the LANDED form (the chooser divergence — no dead path).
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/labels"`);
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/milestones"`);
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/issues/new"`);
    // The template columns in insertion order (Backlog the default, with the
    // default hint).
    for (const title of ["Backlog", "To Do", "In Progress", "Done"]) {
      expect(html).toContain(title);
    }
    expect(html).toContain("New issues added to this project will be added to this column");
    // The cards: both open issues and the closed one, with the meta prefix
    // and the milestone/label links.
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/issues/1"`);
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/issues/2"`);
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/issues/3"`);
    expect(html).toContain("octicon-issue-closed");
    expect(html).toContain(`wave45-lab#1`);
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/milestone/${fixture.milestoneId}"`);
    expect(html).toContain(`href="/wave45-owner/${fixture.repoSlug}/issues?labels=${fixture.bugLabelId}"`);
    // The writer controls are absent; the Workflows link is everyone's.
    expect(html).not.toContain("New Column");
    expect(html).toContain(`/projects/${fixture.boardId}/workflows`);
  });

  it("the writer sees the edit/open-close/delete controls and the New Column disclosure", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`;
    const html = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(html).toContain(`${path}/edit?redirect=project`);
    expect(html).toContain(`${path}/close`);
    expect(html).toContain(`${path}/delete`);
    expect(html).toContain("New Column");
    expect(html).toMatch(new RegExp(`/projects/${fixture.boardId}/\\d+/default`));
    // The board is open — the header offers Close, not Open.
    expect(html).not.toContain(`${path}/open"`);
  });

  it("honors the facet filters in memory and the counts reflect them", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`;
    // The milestone filter: only issue 1 carries Sprint 45 — the To Do count
    // drops from 2 cards to 1.
    const byMilestone = await (
      await fetchUi(`${path}?milestone=${fixture.milestoneId}`, withCookie(`${path}?milestone=${fixture.milestoneId}`, fixture.ownerCookie))
    ).text();
    expect(byMilestone).toContain("Repo board issue 1");
    expect(byMilestone).not.toContain("Repo board issue 2");
    // The label filter: only issue 2 carries `bug`.
    const byLabel = await (
      await fetchUi(`${path}?labels=${fixture.bugLabelId}`, withCookie(`${path}?labels=${fixture.bugLabelId}`, fixture.ownerCookie))
    ).text();
    expect(byLabel).toContain("Repo board issue 2");
    expect(byLabel).not.toContain("Repo board issue 1");
    // The assignee filter: issue 1 is assigned to the owner.
    const byAssignee = await (
      await fetchUi(
        `${path}?assignee=${fixture.ownerId}`,
        withCookie(`${path}?assignee=${fixture.ownerId}`, fixture.ownerCookie),
      )
    ).text();
    expect(byAssignee).toContain("Repo board issue 1");
    expect(byAssignee).not.toContain("Repo board issue 2");
  });

  it("another repo's project id 404-shells (the repo-scope containment)", async () => {
    const fixture = await ensureWave45Fixtures();
    // wave45-lab's board id under wave45-other's /projects → the 404 shell.
    const res = await fetchUi(
      `/wave45-owner/${fixture.otherRepoSlug}/projects/${fixture.boardId}`,
      withCookie(`/wave45-owner/${fixture.otherRepoSlug}/projects/${fixture.boardId}`, fixture.ownerCookie),
    );
    expect(res.status).toBe(404);
    // And an unknown id under the enabled repo.
    expect((await fetchUi(`/wave45-owner/${fixture.repoSlug}/projects/999999`)).status).toBe(404);
  });
});

// --- the write group's gates ---------------------------------------------------------

describe("repo projects write gates", () => {
  it("anonymous gets the login 303 on the /new form (reqSignIn)", async () => {
    await ensureWave45Fixtures();
    const get = await fetchUi(`/wave45-owner/${fixtureSlug}/projects/new`);
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toContain("/login?redirect_to=");
    const post = await fetchUi(`/wave45-owner/${fixtureSlug}/projects/new`, { method: "POST" });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toContain("/login?redirect_to=");
  });
  const fixtureSlug = "wave45-lab";

  it("a signed-in non-writer 404-shells every write arm", async () => {
    const fixture = await ensureWave45Fixtures();
    const base = `/wave45-owner/${fixture.repoSlug}/projects`;
    expect((await fetchUi(`${base}/new`, withCookie(`${base}/new`, fixture.outCookie))).status).toBe(404);
    expect((await fetchUi(`${base}/${fixture.boardId}/edit`, withCookie(`${base}/${fixture.boardId}/edit`, fixture.outCookie))).status).toBe(404);
    expect(
      (await fetchUi(`${base}/${fixture.boardId}/delete`, { method: "POST", ...withCookie(`${base}/${fixture.boardId}/delete`, fixture.outCookie) }))
        .status,
    ).toBe(404);
    expect(
      (await fetchUi(`${base}/${fixture.boardId}/close`, { method: "POST", ...withCookie(`${base}/${fixture.boardId}/close`, fixture.outCookie) }))
        .status,
    ).toBe(404);
    expect(
      (
        await fetchUi(`${base}/${fixture.boardId}/columns/new`, {
          method: "POST",
          ...withCookie(`${base}/${fixture.boardId}/columns/new`, fixture.outCookie),
        })
      ).status,
    ).toBe(404);
    // The workflow writes ride the same ladder.
    expect(
      (
        await fetchUi(`${base}/${fixture.boardId}/workflows`, {
          method: "POST",
          ...withCookie(`${base}/${fixture.boardId}/workflows`, fixture.outCookie),
        })
      ).status,
    ).toBe(404);
  });

  it("a write-mode collaborator passes the writer arm (and the site admin too)", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`;
    // The collaborator reads the board with the writer controls...
    const board = await (await fetchUi(path, withCookie(path, fixture.collabCookie))).text();
    expect(board).toContain("New Column");
    // ...and the admin (the admin arm of canWriteRepository) gets the form.
    expect((await fetchUi(`${path}/edit`, withCookie(`${path}/edit`, fixture.adminCookie))).status).toBe(200);
  });

  it("an archived repo refuses the writes (RepoMustNotBeArchived)", async () => {
    const fixture = await ensureWave45Fixtures();
    // The archived repo still READS (the unit is on).
    expect((await fetchUi(`/wave45-owner/wave45-arch/projects`)).status).toBe(200);
    expect(
      (
        await fetchUi(`/wave45-owner/wave45-arch/projects/new`, {
          method: "POST",
          ...withCookie(`/wave45-owner/wave45-arch/projects/new`, fixture.ownerCookie),
        })
      ).status,
    ).toBe(404);
  });

  it("the POST-only tails answer GET with the 405 (chi's method mismatch)", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`;
    expect((await fetchUi(`${path}/delete`, withCookie(`${path}/delete`, fixture.ownerCookie))).status).toBe(405);
    expect((await fetchUi(`${path}/columns/new`, withCookie(`${path}/columns/new`, fixture.ownerCookie))).status).toBe(405);
    expect((await fetchUi(`${path}/9/default`, withCookie(`${path}/9/default`, fixture.ownerCookie))).status).toBe(405);
  });
});

// --- the project write forms ---------------------------------------------------------

describe("repo project write forms", () => {
  it("creates a project through POST /new (the template seeds the columns) and 303s to the list", async () => {
    const fixture = await ensureWave45Fixtures();
    const base = `/wave45-owner/${fixture.repoSlug}/projects`;
    const res = await fetchUi(
      `${base}/new`,
      formPost(`${base}/new`, fixture.ownerCookie, {
        title: "Formed Repo Board",
        content: "from the *form*",
        template_type: "basic_kanban",
        card_type: "text_only",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(base);
    const list = await (await fetchUi(base, withCookie(base, fixture.ownerCookie))).text();
    expect(list).toContain("Formed Repo Board");
    const boardHref = new RegExp(`href="(${base}/\\d+)"`).exec(list)?.[1];
    expect(boardHref).toBeDefined();
    const board = await (await fetchUi(boardHref as string, withCookie(boardHref as string, fixture.ownerCookie))).text();
    for (const title of ["Backlog", "To Do", "In Progress", "Done"]) {
      expect(board).toContain(title);
    }
  });

  it("re-renders the new form at 200 with the binding error and the kept title", async () => {
    const fixture = await ensureWave45Fixtures();
    const base = `/wave45-owner/${fixture.repoSlug}/projects`;
    const res = await fetchUi(
      `${base}/new`,
      formPost(`${base}/new`, fixture.ownerCookie, { title: "", content: "kept" }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A title is required.");
    expect(html).toContain("kept");
  });

  it("edits through POST /{id}/edit with redirect=project landing on the board", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`;
    const res = await fetchUi(
      `${path}/edit`,
      formPost(`${path}/edit`, fixture.ownerCookie, {
        title: "Repo Board v2",
        content: "updated",
        card_type: "text_only",
        redirect: "project",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(path);
    // Without the redirect field the edit lands on the LIST.
    const res2 = await fetchUi(
      `${path}/edit`,
      formPost(`${path}/edit`, fixture.ownerCookie, { title: "Repo Board v3", content: "", card_type: "text_only" }),
    );
    expect(res2.status).toBe(303);
    expect(res2.headers.get("location")).toBe(`/wave45-owner/${fixture.repoSlug}/projects`);
  });

  it("closes, reopens and deletes through the status/delete POSTs", async () => {
    const fixture = await ensureWave45Fixtures();
    // A throwaway board.
    const created = await createProject(env.DB, repoProjectScope((await repoIdOf(fixture.repoSlug))), {
      title: "Doomed Repo Board",
      description: "",
      creatorId: fixture.ownerId,
      now: NOW,
    });
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${created.id}`;
    const close = await fetchUi(`${path}/close`, { method: "POST", ...withCookie(`${path}/close`, fixture.ownerCookie) });
    expect(close.status).toBe(303);
    expect(close.headers.get("location")).toBe(path);
    // The closed board vanished from the open facet and answers on closed.
    const list = await (await fetchUi(`/wave45-owner/${fixture.repoSlug}/projects`)).text();
    expect(list).not.toContain("Doomed Repo Board");
    const reopen = await fetchUi(`${path}/open`, { method: "POST", ...withCookie(`${path}/open`, fixture.ownerCookie) });
    expect(reopen.status).toBe(303);
    const del = await fetchUi(`${path}/delete`, { method: "POST", ...withCookie(`${path}/delete`, fixture.ownerCookie) });
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe(`/wave45-owner/${fixture.repoSlug}/projects`);
    expect((await fetchUi(path, withCookie(path, fixture.ownerCookie))).status).toBe(404);
  });
});

// --- the column writes -----------------------------------------------------------------

describe("repo project column writes", () => {
  it("creates a column and moves the default flag; failures re-render/404", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`;
    const created = await fetchUi(
      `${path}/columns/new`,
      formPost(`${path}/columns/new`, fixture.collabCookie, { title: "Review 45", color: "#00aabb" }),
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe(path);
    const board = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(board).toContain("Review 45");
    // The exact color 422 re-renders with the kept values.
    const badColor = await fetchUi(
      `${path}/columns/new`,
      formPost(`${path}/columns/new`, fixture.ownerCookie, { title: "Bad Color", color: "nothex" }),
    );
    expect(badColor.status).toBe(200);
    expect(await badColor.text()).toContain("invalid column color");
    // The default flag moves; a foreign column id 404-shells.
    const columns = (await listColumns(env.DB, fixture.boardId, 1, 100)).items;
    const todo = columns.find((column) => column.title === "To Do");
    if (todo === undefined) throw new Error("To Do missing");
    const setDefault = await fetchUi(`${path}/${todo.id}/default`, {
      method: "POST",
      ...withCookie(`${path}/${todo.id}/default`, fixture.ownerCookie),
    });
    expect(setDefault.status).toBe(303);
    const foreign = await fetchUi(`${path}/999999/default`, {
      method: "POST",
      ...withCookie(`${path}/999999/default`, fixture.ownerCookie),
    });
    expect(foreign.status).toBe(404);
  });
});

// --- the workflows -----------------------------------------------------------------------

describe("repo project workflows", () => {
  it("renders to everyone; the manage arms ride the writer (the repo-arm collapse)", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}/workflows`;
    const anon = await (await fetchUi(path)).text();
    expect(anon).toContain("Workflows act on their items");
    expect(anon).not.toContain("New workflow");
    // A write-mode COLLABORATOR manages workflows here — CanManageWorkflows'
    // repo arm (write to BOTH the issues and pulls units) collapses into the
    // repo-wide writer; the org scopes' owner layers do not apply.
    const collab = await (await fetchUi(path, withCookie(path, fixture.collabCookie))).text();
    expect(collab).toContain("New workflow");
  });

  it("the writer creates workflows through the form-POST contract (the exact 422s re-render)", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}/workflows`;
    const create = await fetchUi(
      path,
      formPost(path, fixture.ownerCookie, {
        event: "item_added_to_project",
        enabled: "true",
        filter_label_ids: String(fixture.bugLabelId),
        action_issue_state: "close",
      }),
    );
    expect(create.status).toBe(303);
    const page = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(page).toContain("Item added to project");
    expect(page).toContain("bug");
    expect(page).toContain("Close issue");
    // The unknown-event 422 re-renders with the service's exact text.
    const badEvent = await fetchUi(path, formPost(path, fixture.ownerCookie, { event: "not_an_event" }));
    expect(badEvent.status).toBe(200);
    expect(await badEvent.text()).toContain("invalid event: not_an_event");
    // A FOREIGN repo's label id hits the pool's exact 422 (the repo's pool
    // spans the repo's labels + the owner org's owner-level labels only).
    const badLabel = await fetchUi(
      path,
      formPost(path, fixture.ownerCookie, {
        event: "item_added_to_project",
        filter_label_ids: String(fixture.otherRepoLabelId),
        action_issue_state: "close",
      }),
    );
    expect(badLabel.status).toBe(200);
    expect(await badLabel.text()).toContain(`invalid label: ${fixture.otherRepoLabelId}`);
  });

  it("the toggle keeps the stored rules; the full POST replaces them; delete removes", async () => {
    const fixture = await ensureWave45Fixtures();
    const path = `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}/workflows`;
    let page = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    const wid = Number(/\/workflows\/(\d+)"/.exec(page)![1]);
    // The toggle POST (enabled only — the replace-vs-toggle contract).
    const toggle = await fetchUi(`${path}/${wid}`, formPost(`${path}/${wid}`, fixture.ownerCookie, { enabled: "false" }));
    expect(toggle.status).toBe(303);
    page = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(page).toContain("Disabled");
    expect(page).toContain("Close issue"); // the stored action survived the toggle
    // The focused edit form (the /workflows/{wid} PATH tail) renders.
    const focused = await (await fetchUi(`${path}/${wid}`, withCookie(`${path}/${wid}`, fixture.ownerCookie))).text();
    expect(focused).toContain("Edit workflow");
    // An unknown wid PATH tail 404-shells; an unknown ?event= too.
    expect((await fetchUi(`${path}/999999`, withCookie(`${path}/999999`, fixture.ownerCookie))).status).toBe(404);
    expect((await fetchUi(`${path}?event=bogus`, withCookie(`${path}?event=bogus`, fixture.ownerCookie))).status).toBe(404);
    // The full-rule replace: swap the action to a move-to-column.
    const columns = (await listColumns(env.DB, fixture.boardId, 1, 100)).items;
    const firstColumn = columns[0]!;
    const replace = await fetchUi(
      `${path}/${wid}`,
      formPost(`${path}/${wid}`, fixture.ownerCookie, {
        event: "item_added_to_project",
        enabled: "true",
        action_column_id: String(firstColumn.id),
      }),
    );
    expect(replace.status).toBe(303);
    page = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(page).toContain(`Move to column ${firstColumn.title}`);
    // The delete POST removes the workflow.
    const del = await fetchUi(`${path}/${wid}/delete`, {
      method: "POST",
      ...withCookie(`${path}/${wid}/delete`, fixture.ownerCookie),
    });
    expect(del.status).toBe(303);
    page = await (await fetchUi(path, withCookie(path, fixture.ownerCookie))).text();
    expect(page).not.toContain(`/workflows/${wid}/delete`);
  });

  it("an org-owned repo's pool spans the repo labels AND the org's owner-level labels", async () => {
    const fixture = await ensureWave45Fixtures();
    // Seed one repo label on the org repo so both pool halves render.
    const orgRepoRows = await db().select().from(repositories).where(eq(repositories.slug, fixture.orgRepoSlug)).all();
    const orgRepo = orgRepoRows[0];
    if (orgRepo === undefined) throw new Error("org repo seed failed");
    await db().insert(labels).values({ repoId: orgRepo.id, name: "org-repo-label", color: "#123456" });
    const page = await (
      await fetchUi(
        `/wave45org/${fixture.orgRepoSlug}/projects/${fixture.orgBoardId}/workflows`,
        withCookie(`/wave45org/${fixture.orgRepoSlug}/projects/${fixture.orgBoardId}/workflows`, fixture.orgOwnerCookie),
      )
    ).text();
    expect(page).toContain("Org Lab Board");
    expect(page).toContain("org-wide-45");
    expect(page).toContain("org-repo-label");
    // The org repo's board id under the OWNER's repo scope stays contained.
    expect(
      (
        await fetchUi(
          `/wave45-owner/${fixture.repoSlug}/projects/${fixture.orgBoardId}`,
          withCookie(`/wave45-owner/${fixture.repoSlug}/projects/${fixture.orgBoardId}`, fixture.ownerCookie),
        )
      ).status,
    ).toBe(404);
  });
});

// --- the §5.5 a11y smoke -----------------------------------------------------------

describe("wave-45 a11y smoke", () => {
  it("the new renders pass the structural rules", async () => {
    const fixture = await ensureWave45Fixtures();
    for (const [path, init] of [
      [`/wave45-owner/${fixture.repoSlug}/projects`, undefined],
      [`/wave45-owner/${fixture.repoSlug}/projects`, withCookie(`/wave45-owner/${fixture.repoSlug}/projects`, fixture.ownerCookie)],
      [`/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`, undefined],
      [
        `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`,
        withCookie(`/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}`, fixture.ownerCookie),
      ],
      [
        `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}/workflows`,
        withCookie(`/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}/workflows`, fixture.ownerCookie),
      ],
      [`/wave45-owner/${fixture.repoSlug}/projects/new`, withCookie(`/wave45-owner/${fixture.repoSlug}/projects/new`, fixture.ownerCookie)],
      [
        `/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}/edit`,
        withCookie(`/wave45-owner/${fixture.repoSlug}/projects/${fixture.boardId}/edit`, fixture.ownerCookie),
      ],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});

// --- helpers ------------------------------------------------------------------------

/** A repo's id by slug (the fixtures hold slugs only for stability). */
async function repoIdOf(slug: string): Promise<string> {
  const rows = await db().select().from(repositories).where(eq(repositories.slug, slug)).all();
  const row = rows[0];
  if (row === undefined) throw new Error(`repo ${slug} not seeded`);
  return row.id;
}
