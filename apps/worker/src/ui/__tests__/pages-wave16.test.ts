/**
 * Pages wave 16 route tests — the SPEC-0007 §3.5 UI render-gate tail (commit
 * 5f6d798's flagged gap): the page render gates (`canWriteRepo`/
 * `canAdminRepo`) evaluate the LANDED service predicates
 * (`canWriteRepository`/`isRepositoryAdmin`, api/services/repo-access.ts)
 * through the ../repo-grants bridge instead of a session-viewer fork, so a
 * write/admin-mode org-team member — who could always POST through the API
 * seams — now SEES the controls (the file view's Edit/Delete + New File
 * chrome, the editor routes, the settings family incl. the wave-15 branches
 * panel, the milestones New button, the issue-page admin label form).
 *
 * Fixture recipe mirrors api/team-write-grants.test.ts: a public org repo
 * (org-owned, so the team arms have an org to resolve; the engine content
 * seeds through the REAL receive flow as the org owner — the Owners-team
 * bridge admits that push), one team per mode (write/read/admin) with one
 * member each, identities riding minted session cookies.
 *
 * The matrix under test: a write-team member sees the editor entry and
 * commits through it but NOT the settings family; an admin-team member (and
 * the org owner through the Owners-bridge arm of the same composition) sees
 * both; a read-team member sees none of it but still GETs every page
 * (issues stay open to every signed-in viewer — not gated on write, the
 * upstream posture this UI keeps). Scope note: the PAGE-VISIBILITY seam
 * (repo-view's readGrant) is a separate flag — a private org repo's pages
 * still 404 for team members; these fixtures use a public repo so the
 * render gates are reachable at all.
 *
 * Same harness posture as pages-wave2..15: the router is driven directly
 * with the synthetic ASSETS manifest; rerun-convergent by construction (the
 * one editor POST writes a distinct file that deleteFileIfExists pre-cleans).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, teamMembers, teamRepoAccess, teams, type TeamAccessMode } from "../../db/schema";
import { uiRouter } from "../index";
import { IssuesService } from "../../issues/service";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

/** A form POST with the browser's Origin header (the §2.8 guard's happy path). */
function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
    body: new URLSearchParams(fields).toString(),
  };
}

// --- fixtures -----------------------------------------------------------------

const WAVE16_COMMITS: SeedCommit[] = [
  { message: "seed: rig readme", time: T0, files: [{ path: "README.md", content: "# rig\n\nTeam-grant fixture.\n" }] },
];

interface Wave16Fixture {
  ownerCookie: string; // the org owner (the Owners-team bridge arm)
  writeCookie: string; // write-mode team member
  readCookie: string; // read-mode team member
  adminCookie: string; // admin-mode team member
  repoId: string;
  issueIndex: number;
}

let wave16Fixture: Wave16Fixture | null = null;

/** One team with one member, covering the fixture repo (the
 * team-write-grants.test.ts seeding shape). */
async function seedTeam(
  org: OrgRecord,
  name: string,
  authorize: TeamAccessMode,
  userId: number,
  repoId: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const inserted = await db
    .insert(teams)
    .values({ orgId: org.id, lowerName: name, name, authorize, visibility: "private" })
    .returning({ id: teams.id })
    .all();
  const teamId = inserted[0]!.id;
  await db.insert(teamMembers).values({ orgId: org.id, teamId, userId });
  await db.insert(teamRepoAccess).values({ orgId: org.id, teamId, repoId });
}

async function ensureWave16Fixtures(): Promise<Wave16Fixture> {
  if (wave16Fixture !== null) return wave16Fixture;
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "wave16-master" });
  const writeMate = await seedVerifiedUser({ username: "wave16-write" });
  const readMate = await seedVerifiedUser({ username: "wave16-read" });
  const adminMate = await seedVerifiedUser({ username: "wave16-admin" });

  const org = await new OrgService(env.DB).createOrg({ name: "wave16forge", ownerId: owner.id });
  const repo = await new RepoService(env.DB).create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: "rig",
    isPrivate: false,
    status: "ready",
  });
  // REAL engine content, pushed as the org owner (the Owners-team bridge
  // admits the push — the git-HTTP write arm of the same composition).
  await ensureSeededRepo({ owner: org.usernameLower, slug: repo.slug, commits: WAVE16_COMMITS });

  await seedTeam(org, "writers", "write", writeMate.id, repo.id);
  await seedTeam(org, "readers", "read", readMate.id, repo.id);
  await seedTeam(org, "maintainers", "admin", adminMate.id, repo.id);

  // The issue the admin label-form arm renders against.
  const issue = await new IssuesService(env.DB).createIssue({
    repoId: repo.id,
    title: "wave16: label-form fixture",
    posterId: owner.id,
    now: new Date(T0 * 1000),
  });

  wave16Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    writeCookie: await mintSession(env.DB, writeMate.id),
    readCookie: await mintSession(env.DB, readMate.id),
    adminCookie: await mintSession(env.DB, adminMate.id),
    repoId: repo.id,
    issueIndex: issue.index,
  };
  return wave16Fixture;
}

/** The live blob oid of `path` on the fixture repo's main branch. */
async function blobOid(path: string): Promise<string | null> {
  const fixture = await ensureWave16Fixtures();
  const repo = await drizzle(env.DB)
    .select({ ownerNamespace: repositories.ownerNamespace })
    .from(repositories)
    .where(eq(repositories.id, fixture.repoId))
    .get();
  if (repo === undefined) throw new Error("wave16 repo row missing");
  const blob = await env.REPO.getByName(`${repo.ownerNamespace}/rig`).readBlob("main", path);
  return blob?.oid ?? null;
}

/** Pre-clean a create-test target through the editor's own delete POST. */
async function deleteFileIfExists(cookie: string, path: string): Promise<void> {
  const sha = await blobOid(path);
  if (sha === null) return;
  await fetchUi(`/wave16forge/rig/delete/main/${path}`, withCookie(formPost({ tree_path: path, branch: "main", blob_sha: sha }), cookie));
}

beforeAll(async () => {
  await ensureWave16Fixtures();
});

// --- the file view's write chrome (the flagged "Edit links") -------------------

describe("file view write chrome rides the team grant", () => {
  it("the write-team member sees the New File link and the Edit/Delete actions", async () => {
    const fixture = await ensureWave16Fixtures();
    const tree = await fetchUi("/wave16forge/rig/src/branch/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.writeCookie}` },
    });
    expect(tree.status).toBe(200);
    const treeHtml = await tree.text();
    expect(treeHtml).toContain('href="/wave16forge/rig/new/main"');

    const blob = await fetchUi("/wave16forge/rig/src/branch/main/README.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.writeCookie}` },
    });
    expect(blob.status).toBe(200);
    const blobHtml = await blob.text();
    expect(blobHtml).toContain('href="/wave16forge/rig/edit/main/README.md"');
    expect(blobHtml).toContain('href="/wave16forge/rig/delete/main/README.md"');
  });

  it("the read-team member still GETs every page but sees none of the controls", async () => {
    const fixture = await ensureWave16Fixtures();
    const tree = await fetchUi("/wave16forge/rig/src/branch/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.readCookie}` },
    });
    expect(tree.status, "the read-team member can still GET the page").toBe(200);
    const treeHtml = await tree.text();
    expect(treeHtml).not.toContain('href="/wave16forge/rig/new/main"');

    const blob = await fetchUi("/wave16forge/rig/src/branch/main/README.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.readCookie}` },
    });
    expect(blob.status).toBe(200);
    const blobHtml = await blob.text();
    expect(blobHtml).not.toContain("/edit/main/README.md");
    expect(blobHtml).not.toContain("/delete/main/README.md");
  });

  it("the admin-team member and the org owner see the controls (the admin arm ranks write)", async () => {
    const fixture = await ensureWave16Fixtures();
    for (const cookie of [fixture.adminCookie, fixture.ownerCookie]) {
      const blob = await fetchUi("/wave16forge/rig/src/branch/main/README.md", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(blob.status).toBe(200);
      const blobHtml = await blob.text();
      expect(blobHtml).toContain('href="/wave16forge/rig/edit/main/README.md"');
      expect(blobHtml).toContain('href="/wave16forge/rig/delete/main/README.md"');
    }
  });
});

// --- the editor routes (entry + the end-to-end write) ---------------------------

describe("editor routes ride the team grant", () => {
  it("the write-team member renders the edit form and lands a commit through it", async () => {
    const fixture = await ensureWave16Fixtures();
    const page = await fetchUi("/wave16forge/rig/edit/main/README.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.writeCookie}` },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="edit_area"');

    await deleteFileIfExists(fixture.writeCookie, "wave16-note.txt");
    const created = await fetchUi(
      "/wave16forge/rig/new/main",
      withCookie(
        formPost({ tree_path: "wave16-note.txt", content: "team-written\n", branch: "main" }),
        fixture.writeCookie,
      ),
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/wave16forge/rig/src/branch/main/wave16-note.txt");
    expect(await blobOid("wave16-note.txt")).not.toBeNull();
  });

  it("the read-team member 404-shells the editor entry and its POST", async () => {
    const fixture = await ensureWave16Fixtures();
    const page = await fetchUi("/wave16forge/rig/edit/main/README.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.readCookie}` },
    });
    expect(page.status).toBe(404);

    const created = await fetchUi(
      "/wave16forge/rig/new/main",
      withCookie(formPost({ tree_path: "wave16-nope.txt", content: "x", branch: "main" }), fixture.readCookie),
    );
    expect(created.status).toBe(404);
    expect(await blobOid("wave16-nope.txt")).toBeNull();
  });

  it("the admin-team member renders the editor entry", async () => {
    const fixture = await ensureWave16Fixtures();
    const page = await fetchUi("/wave16forge/rig/edit/main/README.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(page.status).toBe(200);
  });
});

// --- the settings family (incl. the wave-15 branches panel) ----------------------

describe("settings family rides the admin grant", () => {
  it("the admin-team member and the org owner render the settings pages, the write/read members do not", async () => {
    const fixture = await ensureWave16Fixtures();
    for (const cookie of [fixture.adminCookie, fixture.ownerCookie]) {
      const settings = await fetchUi("/wave16forge/rig/settings", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(settings.status).toBe(200);
      const branches = await fetchUi("/wave16forge/rig/settings/branches", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(branches.status).toBe(200);
    }
    for (const cookie of [fixture.writeCookie, fixture.readCookie]) {
      const settings = await fetchUi("/wave16forge/rig/settings", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(settings.status).toBe(404);
      const branches = await fetchUi("/wave16forge/rig/settings/branches", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(branches.status).toBe(404);
    }
  });

  it("the anonymous viewer still 303s onto the login round-trip ahead of the grant", async () => {
    await ensureWave16Fixtures();
    const anon = await fetchUi("/wave16forge/rig/settings");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Fwave16forge%2Frig%2Fsettings");
  });
});

// --- the other admin-arm render gates ---------------------------------------------

describe("milestones New button and the issue-page label form ride the admin grant", () => {
  it("the write-team member sees neither; the admin-team member sees both", async () => {
    const fixture = await ensureWave16Fixtures();
    const writeMilestones = await fetchUi("/wave16forge/rig/milestones", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.writeCookie}` },
    });
    expect(writeMilestones.status).toBe(200);
    expect(await writeMilestones.text()).not.toContain('href="/wave16forge/rig/milestones/new"');

    const writeIssue = await fetchUi(`/wave16forge/rig/issues/${fixture.issueIndex}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.writeCookie}` },
    });
    expect(writeIssue.status).toBe(200);
    expect(await writeIssue.text()).not.toContain('action="/wave16forge/rig/issues/labels"');

    const adminMilestones = await fetchUi("/wave16forge/rig/milestones", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(adminMilestones.status).toBe(200);
    expect(await adminMilestones.text()).toContain('href="/wave16forge/rig/milestones/new"');

    const adminIssue = await fetchUi(`/wave16forge/rig/issues/${fixture.issueIndex}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(adminIssue.status).toBe(200);
    expect(await adminIssue.text()).toContain('action="/wave16forge/rig/issues/labels"');
  });

  it("issues stay open to every signed-in viewer (the new-issue gate is not a write gate)", async () => {
    const fixture = await ensureWave16Fixtures();
    const page = await fetchUi("/wave16forge/rig/issues/new", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.readCookie}` },
    });
    expect(page.status).toBe(200);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-16 a11y smoke", () => {
  it("the team-granted renders pass the structural rules", async () => {
    const fixture = await ensureWave16Fixtures();
    for (const path of [
      "/wave16forge/rig/src/branch/main/README.md",
      "/wave16forge/rig/edit/main/README.md",
      "/wave16forge/rig/settings",
    ]) {
      const res = await fetchUi(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` } });
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
