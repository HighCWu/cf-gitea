/**
 * Pages wave 37 route tests — the UI-parity survey's regenerated top-5 row 5
 * (docs/compat/ui-parity-survey.md): `GET /{username}/-/projects`
 * (web.go:1137-1163) — the `/-` namespace's projects board LISTING over the
 * landed projects service family, serving BOTH owner kinds through upstream's
 * single handler (org.Projects branches on ContextUser.IsOrganization).
 *
 * Pins asserted:
 *   - the parser claims exactly the bare `/-/projects` tail (the board depth
 *     `/{id}`, the workflows tails, and the write group stay unclaimed → the
 *     engine's 404 — the follow-up row the page module documents);
 *   - the USER arm's gate is the individualPermsChecker ladder
 *     (web.go:945-959) — TIGHTER than the profile visibility: a private
 *     user's projects page 404-shells for a FOLLOWER (no follower/co-member
 *     arm), answering to self or site admin only; limited needs any
 *     signed-in viewer;
 *   - the ORG arm's gate is orgProjectsAccessMode >= read (web.go:444-455's
 *     org arm) on top of the org-home visibility ladder — a public org lists
 *     to anonymous (the team-less visibility fallback), a private org to its
 *     owner only;
 *   - the counts matrix: rows carry the doer-visibility-FILTERED issue
 *     counts (LoadIssueNumbersForProject's owner branch) — an anonymous
 *     viewer's numbers exclude private-repo items, the owner's include them;
 *   - the `?state=closed` facet + the writer-only toggle (canWriteProjects:
 *     org → projects-unit write, user → doer == owner; the New Project
 *     button renders nowhere — unclaimed route);
 *   - pagination over IssuePagingNum = 20 and the rename-307 seam.
 *
 * Same harness posture as pages-wave23: the router is driven directly with
 * the synthetic ASSETS manifest; D1-only fixtures (no engine content — the
 * page reads no git data).
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { follows, issues, projectIssues, projects, userRedirects, users } from "../../db/schema";
import { createProject, orgProjectScope, userProjectScope } from "../../api/services/projects";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { uiEnv } from "./harness";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (path: string, cookie: string): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

// --- fixtures -----------------------------------------------------------------

interface Wave37Fixture {
  ownerCookie: string; // wave37-user — the public user arm's owner
  privCookie: string; // wave37-priv — a private user
  limCookie: string; // wave37-lim — a limited user
  adminCookie: string; // wave37-admin — a site admin
  outCookie: string; // wave37-out — a signed-in outsider
  followerCookie: string; // wave37-follower — follows the private user
  orgOwnerCookie: string; // wave37-orgowner — owns the public org
  privOrgOwnerCookie: string; // wave37-porgowner — owns the private org
}

let wave37Fixture: Wave37Fixture | null = null;

const NOW = new Date(1_700_000_000 * 1000);
const db = () => drizzle(env.DB);

/** One individual project row (type 1) — a template-less board (no columns,
 *  the service's TemplateTypeNone arm); memberships carry projectColumnId 0,
 *  the legacy default-column encoding the counts join ignores. */
async function seedProject(ownerId: number, creatorId: number, title: string, isClosed = false) {
  const row = await createProject(env.DB, userProjectScope(ownerId), {
    title,
    description: "",
    creatorId,
    now: NOW,
  });
  if (isClosed) {
    await db().update(projects).set({ isClosed }).where(eq(projects.id, row.id));
  }
  return row;
}

async function seedIssue(repoId: string, index: number, isClosed = false) {
  const rows = await db()
    .insert(issues)
    .values({ repoId, index, title: `Issue ${index}`, createdAt: NOW, updatedAt: NOW, isClosed })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("issue seed failed");
  return row;
}

async function seedMembership(issueId: number, projectId: number) {
  await db().insert(projectIssues).values({ issueId, projectId, projectColumnId: 0, sorting: 0 });
}

async function ensureWave37Fixtures(): Promise<Wave37Fixture> {
  if (wave37Fixture !== null) return wave37Fixture;
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "wave37-user" });
  const priv = await seedVerifiedUser({ username: "wave37-priv" });
  const lim = await seedVerifiedUser({ username: "wave37-lim" });
  const admin = await seedVerifiedUser({ username: "wave37-admin", isAdmin: true });
  const out = await seedVerifiedUser({ username: "wave37-out" });
  const follower = await seedVerifiedUser({ username: "wave37-follower" });
  const orgOwner = await seedVerifiedUser({ username: "wave37-orgowner" });
  const privOrgOwner = await seedVerifiedUser({ username: "wave37-porgowner" });

  // The visibility-ladder variants (the seeds default to public).
  await db().update(users).set({ visibility: "private" }).where(eq(users.id, priv.id));
  await db().update(users).set({ visibility: "limited" }).where(eq(users.id, lim.id));
  // The private user's follower (the follower's row: userId follows followId).
  await db().insert(follows).values({ userId: follower.id, followId: priv.id, createdAt: NOW });

  // --- the public user's boards: the counts-matrix fixture ---------------
  // One public repo (2 open + 1 closed issues) + one private repo (3 open
  // issues) claimed by the SAME open project — an anonymous viewer's counts
  // exclude the private arm, the owner's include it (upstream
  // LoadIssueNumbersForProject's owner branch through IssuesOptions.Doer).
  const repos = new RepoService(env.DB);
  const pubRepo = await repos.create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: "wave37-pub",
    isPrivate: false,
    status: "ready",
  });
  const privRepo = await repos.create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: "wave37-priv-lab",
    isPrivate: true,
    status: "ready",
  });

  const board = await seedProject(owner.id, owner.id, "Feature Board");
  await seedProject(owner.id, owner.id, "Retired Board", true);

  // Public repo: 2 open + 1 closed. Private repo: 3 open.
  for (const [index, closed] of [
    [1, false],
    [2, false],
    [3, true],
  ] as Array<[number, boolean]>) {
    await seedMembership((await seedIssue(pubRepo.id, index, closed)).id, board.id);
  }
  for (const index of [4, 5, 6]) {
    await seedMembership((await seedIssue(privRepo.id, index)).id, board.id);
  }

  // The private + limited users carry one empty board each (the gate arms).
  await seedProject(priv.id, priv.id, "Private User Board");
  await seedProject(lim.id, lim.id, "Limited User Board");

  // --- the orgs ------------------------------------------------------------
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({
    name: "wave37org",
    ownerId: orgOwner.id,
    visibility: "public",
    fullName: "Wave 37 Forge",
    now: NOW,
  });
  const privOrg = await orgs.createOrg({
    name: "wave37privorg",
    ownerId: privOrgOwner.id,
    visibility: "private",
    now: NOW,
  });
  // The public org: one public repo (the RepoCount label) + one board with a
  // markdown description (the row's render-content arm).
  await repos.create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: "orgrepo",
    isPrivate: false,
    status: "ready",
  });
  const orgBoard = await createProject(env.DB, orgProjectScope(org.id), {
    title: "Org Roadmap",
    description: "A *Cross-repo* planning board",
    creatorId: orgOwner.id,
    now: NOW,
  });
  void orgBoard;
  await createProject(env.DB, orgProjectScope(privOrg.id), {
    title: "Secret Roadmap",
    description: "",
    creatorId: privOrgOwner.id,
    now: NOW,
  });

  wave37Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    privCookie: await mintSession(env.DB, priv.id),
    limCookie: await mintSession(env.DB, lim.id),
    adminCookie: await mintSession(env.DB, admin.id),
    outCookie: await mintSession(env.DB, out.id),
    followerCookie: await mintSession(env.DB, follower.id),
    orgOwnerCookie: await mintSession(env.DB, orgOwner.id),
    privOrgOwnerCookie: await mintSession(env.DB, privOrgOwner.id),
  };
  return wave37Fixture;
}

beforeAll(async () => {
  await ensureWave37Fixtures();
});

// --- the parser claims (the route registry's shape contract) --------------------

describe("wave-37 parser claims", () => {
  it("claims exactly the bare /{owner}/-/projects tail", () => {
    expect(parseUiRoute("/wave37-user/-/projects")).toEqual({ family: "owner-projects", owner: "wave37-user" });
    // The board depth + write group were the follow-up row's — wave 40
    // claimed them (pages/owner-project-board.tsx); the sibling `/-` tails
    // stay unclaimed.
    expect(parseUiRoute("/wave37-user/-/projects/7")).toEqual({
      family: "owner-project-board",
      owner: "wave37-user",
      id: 7,
    });
    expect(parseUiRoute("/wave37-user/-/projects/7/edit")).toEqual({
      family: "owner-project-edit",
      owner: "wave37-user",
      id: 7,
    });
    expect(parseUiRoute("/wave37-user/-/projects/new")).toEqual({ family: "owner-project-new", owner: "wave37-user" });
    expect(parseUiRoute("/wave37-user/-/projects/7/workflows")).toEqual({
      family: "owner-project-workflows",
      owner: "wave37-user",
      id: 7,
    });
    // The `/-` namespace's sibling tails stay unclaimed.
    expect(parseUiRoute("/wave37-user/-/heatmap")).toBeNull();
    expect(parseUiRoute("/wave37-user/-/packages")).toBeNull();
    expect(handlesUiRoute("/wave37-user/-/projects")).toBe(true);
    expect(handlesUiRoute("/wave37-user/-/projects/7")).toBe(true);
  });
});

// --- the USER arm ----------------------------------------------------------------

describe("user projects page /{user}/-/projects", () => {
  it("the anonymous viewer renders the profile-grid chrome, the rows, and public-only counts", async () => {
    await ensureWave37Fixtures();
    const res = await fetchUi("/wave37-user/-/projects");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The user arm's chrome (profile.tmpl: the avatar column + the overview
    // menu with the active Projects tab).
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain("wave37-user");
    expect(html).toContain("Projects");
    // The rows: the title anchors the /{id} board (live since wave 40), the
    // glyph + the visibility-filtered counts. The default facet is OPEN —
    // the closed board lists on ?state=closed.
    expect(html).toContain("Feature Board");
    expect(html).not.toContain("Retired Board");
    expect(html).toContain('href="/wave37-user/-/projects/');
    // The counts matrix: the public repo's 2 open + 1 closed count; the
    // private repo's 3 opens do NOT (anonymous = the AllPublic arm).
    expect(html).toContain("2 Open");
    expect(html).toContain("1 Closed");
    expect(html).not.toContain("5 Open");
    // The writer-only toggle is absent (anonymous is not the owner), and the
    // New Project button renders nowhere (unclaimed route).
    expect(html).not.toContain("list-header-toggle");
    expect(html).not.toContain("New Project");
  });

  it("the owner sees the private-repo items in the row counts and the state toggle", async () => {
    const fixture = await ensureWave37Fixtures();
    const res = await fetchUi("/wave37-user/-/projects", withCookie("/wave37-user/-/projects", fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("list-header-toggle");
    // The counts matrix, owner arm: 2 public opens + 3 private opens.
    expect(html).toContain("5 Open");
    expect(html).toContain("1 Closed");
    // canWriteProjects (doer == owner) renders the facet links.
    expect(html).toContain("?state=open");
    expect(html).toContain("?state=closed");
  });

  it("the ?state=closed facet lists only the closed board", async () => {
    const fixture = await ensureWave37Fixtures();
    const res = await fetchUi(
      "/wave37-user/-/projects?state=closed",
      withCookie("/wave37-user/-/projects?state=closed", fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Retired Board");
    expect(html).not.toContain("Feature Board");
  });

  it("a private user answers to self or site admin ONLY — the follower 404-shells (individualPermsChecker)", async () => {
    const fixture = await ensureWave37Fixtures();
    // The follower sees the PROFILE (the looser IsUserVisibleToViewer) but
    // NOT the projects page — web.go:945-959 has no follower arm.
    expect(
      (await fetchUi("/wave37-priv/-/projects", withCookie("/wave37-priv/-/projects", fixture.followerCookie))).status,
    ).toBe(404);
    expect((await fetchUi("/wave37-priv/-/projects")).status).toBe(404);
    expect(
      (await fetchUi("/wave37-priv/-/projects", withCookie("/wave37-priv/-/projects", fixture.outCookie))).status,
    ).toBe(404);
    expect(
      (await fetchUi("/wave37-priv/-/projects", withCookie("/wave37-priv/-/projects", fixture.adminCookie))).status,
    ).toBe(200);
    const self = await fetchUi(
      "/wave37-priv/-/projects",
      withCookie("/wave37-priv/-/projects", fixture.privCookie),
    );
    expect(self.status).toBe(200);
    expect(await self.text()).toContain("Private User Board");
  });

  it("a limited user answers to any signed-in viewer, 404-shells anonymous", async () => {
    const fixture = await ensureWave37Fixtures();
    expect((await fetchUi("/wave37-lim/-/projects")).status).toBe(404);
    expect(
      (await fetchUi("/wave37-lim/-/projects", withCookie("/wave37-lim/-/projects", fixture.outCookie))).status,
    ).toBe(200);
  });

  it("a renamed user 307s through the shared redirect seam (path rewrite, query preserved)", async () => {
    await ensureWave37Fixtures();
    const rows = await db().select().from(users).where(eq(users.usernameLower, "wave37-user")).all();
    const user = rows[0];
    if (user === undefined) throw new Error("fixture user missing");
    await db().insert(userRedirects).values({ lowerName: "wave37-oldname", redirectUserId: user.id });
    const res = await fetchUi("/wave37-oldname/-/projects?state=closed");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/wave37-user/-/projects?state=closed");
  });

  it("pagination rides IssuePagingNum = 20 (the landed id DESC order)", async () => {
    const pager = await seedVerifiedUser({ username: "wave37-pager" });
    for (let i = 1; i <= 21; i++) {
      await seedProject(pager.id, pager.id, `Pager Board ${String(i).padStart(2, "0")}`);
    }
    // Newest first (the service's id DESC): page 1 carries boards 21..02.
    const page1 = await (await fetchUi("/wave37-pager/-/projects")).text();
    expect(page1).toContain("Pager Board 21");
    expect(page1).not.toContain("Pager Board 01");
    expect(page1).toContain("Older");
    expect(page1).toContain("?page=2");
    const page2 = await (await fetchUi("/wave37-pager/-/projects?page=2")).text();
    expect(page2).toContain("Pager Board 01");
    expect(page2).not.toContain("Pager Board 21");
    expect(page2).toContain("Newer");
  });
});

// --- the ORG arm -----------------------------------------------------------------

describe("org projects page /{org}/-/projects", () => {
  it("a public org lists to anonymous with the org chrome and the rendered description", async () => {
    await ensureWave37Fixtures();
    const res = await fetchUi("/wave37org/-/projects");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content organization projects"');
    expect(html).toContain("Wave 37 Forge");
    expect(html).toContain("Org Roadmap");
    // The markdown description renders through the shared service (the <em>
    // is the renderer's output, not the raw source).
    expect(html).toContain("<em>Cross-repo</em> planning board");
    // Anonymous is not a projects-unit writer — no toggle, no New button.
    expect(html).not.toContain("list-header-toggle");
    expect(html).not.toContain("New Project");
  });

  it("the org owner is a projects writer and sees the toggle", async () => {
    const fixture = await ensureWave37Fixtures();
    const res = await fetchUi(
      "/wave37org/-/projects",
      withCookie("/wave37org/-/projects", fixture.orgOwnerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("list-header-toggle");
  });

  it("a private org 404-shells anonymous and answers its owner", async () => {
    const fixture = await ensureWave37Fixtures();
    expect((await fetchUi("/wave37privorg/-/projects")).status).toBe(404);
    const res = await fetchUi(
      "/wave37privorg/-/projects",
      withCookie("/wave37privorg/-/projects", fixture.privOrgOwnerCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Secret Roadmap");
  });

  it("unknown owners 404-shell", async () => {
    await ensureWave37Fixtures();
    expect((await fetchUi("/wave37-nobody/-/projects")).status).toBe(404);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-37 a11y smoke", () => {
  it("the new renders pass the structural rules", async () => {
    const fixture = await ensureWave37Fixtures();
    for (const [path, init] of [
      ["/wave37-user/-/projects", undefined],
      ["/wave37-user/-/projects", withCookie("/wave37-user/-/projects", fixture.ownerCookie)],
      ["/wave37-user/-/projects?state=closed", withCookie("/wave37-user/-/projects", fixture.ownerCookie)],
      ["/wave37org/-/projects", undefined],
      ["/wave37org/-/projects", withCookie("/wave37org/-/projects", fixture.orgOwnerCookie)],
      ["/wave37-pager/-/projects", undefined],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
