/**
 * Pages wave 24 route tests — the UI-parity survey's bench tier continuation
 * (the two next-ranked data-landed rows after wave 23):
 *
 *   - the `.../forks|stars|watchers` trio (survey family C row web.go:1759 +
 *     family F rows web.go:1766/1767) — the three social list pages over the
 *     landed `listForks` / `listRepoStargazers` / `listRepoSubscribers`
 *     reads, anonymous-capable, upstream's tplWatchers serving BOTH the
 *     stars and watchers pages;
 *   - `GET .../settings/collaboration` (survey family E row web.go:1194) —
 *     the collaborators + teams settings panel behind the settingsGate, with
 *     the add / access_mode / delete and team add/delete writes riding the
 *     landed repo-collaborators + TeamsService arms.
 *
 * Fixture recipe mirrors pages-wave23: D1-only rows through the landed
 * services (no engine content — none of the pages read git data), identities
 * riding minted session cookies, POSTs carrying the same-origin Origin
 * header.
 *
 * w129 additions (wave-polish-matrix-6, 2026-10-27) — the social lists'
 * batch-6 deepening, appended as the trailing w129 describes: the visibility
 * ladder's COLLABORATOR rung on the private repo (wave24 pinned anon /
 * stranger / owner; the trio matrix fsx-* pinned the admin rung — the
 * readGrant collaborator arm was unpinned at the trio's page level), the
 * watchers pager's exact pageSize boundary (total == 40 renders NO pager at
 * page 1), the watchers past-the-end bare-empty arm, and the stargazers
 * past-the-end arm — the user_cards template's no-else reduction rendering a
 * bare empty ul where the forks family renders its no-results line.
 */

import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { findCollaborator, addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { starRepo } from "../../api/services/stars";
import { watchRepo } from "../../api/services/repo-watchers";
import { OrgService } from "../../services/orgs/orgs";
import { TeamsService } from "../../api/routes/org-teams";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (path: string, cookie: string): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

const formPost = (body: Record<string, string>, cookie: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://test.local",
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
  },
  body: new URLSearchParams(body).toString(),
});

// --- fixtures -----------------------------------------------------------------

interface Wave24Fixture {
  ownerCookie: string; // wave24-owner — owns paint
  collabCookie: string; // wave24-collab — write collaborator on paint, admin on project
  readCookie: string; // wave24-read — read collaborator on paint (watcher)
  outCookie: string; // wave24-out — outsider; owns both forks
  orgOwnerCookie: string; // wave24-orgowner — owns wave24org/project
  paintId: string;
  outId: number;
  collabId: number;
  guildTeamId: number;
}

let wave24Fixture: Wave24Fixture | null = null;

async function ensureWave24Fixtures(): Promise<Wave24Fixture> {
  if (wave24Fixture !== null) return wave24Fixture;
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "wave24-owner" });
  const collab = await seedVerifiedUser({ username: "wave24-collab" });
  const read = await seedVerifiedUser({ username: "wave24-read" });
  const out = await seedVerifiedUser({ username: "wave24-out" });
  const orgOwner = await seedVerifiedUser({ username: "wave24-orgowner" });

  const now = new Date(1_700_000_000 * 1000);
  const service = new RepoService(env.DB);

  // The starred/watched/collaborated repo.
  const paint = await service.create({
    owner: { id: owner.id, usernameLower: "wave24-owner" },
    name: "paint",
    isPrivate: false,
    status: "ready",
  });

  // Two forks of paint owned by the outsider: one public, one private (the
  // listForks accessible-condition's two arms). fork_parent rides a direct
  // update — RepoService.create has no fork input (the fork create arm
  // composes the same rows).
  const forkPublic = await service.create({
    owner: { id: out.id, usernameLower: "wave24-out" },
    name: "paint-fork",
    isPrivate: false,
    status: "ready",
  });
  const forkHidden = await service.create({
    owner: { id: out.id, usernameLower: "wave24-out" },
    name: "paint-hidden",
    isPrivate: true,
    status: "ready",
  });
  await drizzle(env.DB)
    .update(repositories)
    .set({ forkParent: paint.id })
    .where(eq(repositories.id, forkPublic.id));
  await drizzle(env.DB)
    .update(repositories)
    .set({ forkParent: paint.id })
    .where(eq(repositories.id, forkHidden.id));

  // The org-owned repo + two teams: Committee (covers project — the GET's
  // row) and Guild (no repo access — the add-team POST's target).
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({
    name: "wave24org",
    ownerId: orgOwner.id,
    visibility: "public",
    fullName: "Wave 24 Forge",
    now,
  });
  const project = await service.create({
    owner: { id: org.id, usernameLower: "wave24org" },
    name: "project",
    isPrivate: false,
    status: "ready",
  });
  const teams = new TeamsService(env.DB);
  const committee = await teams.createTeam(org, { name: "Committee", permission: "write" });
  await teams.addTeamRepo(committee, project.id);
  const guild = await teams.createTeam(org, { name: "Guild", permission: "write" });

  // The social rows: stars (owner + collab), watchers (collab + read).
  await starRepo(env.DB, owner.id, paint.id, now);
  await starRepo(env.DB, collab.id, paint.id, now);
  await watchRepo(env.DB, paint.id, collab.id, now);
  await watchRepo(env.DB, paint.id, read.id, now);

  // The collaborations: paint (write + read), project (admin — the
  // repoAdminChangeTeamAccess=false restricted-note arm).
  await addOrUpdateCollaborator(env.DB, paint.id, collab.id, "write", now);
  await addOrUpdateCollaborator(env.DB, paint.id, read.id, "read", now);
  await addOrUpdateCollaborator(env.DB, project.id, collab.id, "admin", now);

  wave24Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    collabCookie: await mintSession(env.DB, collab.id),
    readCookie: await mintSession(env.DB, read.id),
    outCookie: await mintSession(env.DB, out.id),
    orgOwnerCookie: await mintSession(env.DB, orgOwner.id),
    paintId: paint.id,
    outId: out.id,
    collabId: collab.id,
    guildTeamId: guild.id,
  };
  return wave24Fixture;
}

beforeAll(async () => {
  await ensureWave24Fixtures();
});

// --- the parser claims (the route registry's shape contract) --------------------

describe("wave-24 parser claims", () => {
  it("claims exactly the trio and collaboration shapes", () => {
    expect(parseUiRoute("/wave24-owner/paint/forks")).toEqual({
      family: "forks",
      owner: "wave24-owner",
      repo: "paint",
    });
    expect(parseUiRoute("/wave24-owner/paint/stars")).toEqual({
      family: "stars",
      owner: "wave24-owner",
      repo: "paint",
    });
    expect(parseUiRoute("/wave24-owner/paint/watchers")).toEqual({
      family: "watchers",
      owner: "wave24-owner",
      repo: "paint",
    });
    expect(parseUiRoute("/wave24-owner/paint/settings/collaboration")).toEqual({
      family: "settings-collaboration",
      owner: "wave24-owner",
      repo: "paint",
    });
    expect(parseUiRoute("/wave24-owner/paint/settings/collaboration/access_mode")).toEqual({
      family: "settings-collab-access-mode",
      owner: "wave24-owner",
      repo: "paint",
    });
    expect(parseUiRoute("/wave24-owner/paint/settings/collaboration/delete")).toEqual({
      family: "settings-collab-delete",
      owner: "wave24-owner",
      repo: "paint",
    });
    expect(parseUiRoute("/wave24-owner/paint/settings/collaboration/team")).toEqual({
      family: "settings-collab-team-add",
      owner: "wave24-owner",
      repo: "paint",
    });
    expect(parseUiRoute("/wave24-owner/paint/settings/collaboration/team/delete")).toEqual({
      family: "settings-collab-team-delete",
      owner: "wave24-owner",
      repo: "paint",
    });
    // The sibling shapes stay unclaimed (the engine's 404).
    expect(parseUiRoute("/wave24-owner/paint/forks/extra")).toBeNull();
    expect(parseUiRoute("/wave24-owner/paint/stars/list")).toBeNull();
    expect(parseUiRoute("/wave24-owner/paint/settings/collaboration/other")).toBeNull();
    expect(parseUiRoute("/wave24-owner/paint/settings/collaborate")).toBeNull();
    // handlesUiRoute (the dispatcher's gate) answers the same.
    expect(handlesUiRoute("/wave24-owner/paint/forks")).toBe(true);
    expect(handlesUiRoute("/wave24-owner/paint/stars")).toBe(true);
    expect(handlesUiRoute("/wave24-owner/paint/watchers")).toBe(true);
    expect(handlesUiRoute("/wave24-owner/paint/settings/collaboration")).toBe(true);
    expect(handlesUiRoute("/wave24-owner/paint/forks/extra")).toBe(false);
  });
});

// --- the repo social trio ---------------------------------------------------------

describe("repo social trio /{owner}/{repo}/forks|stars|watchers", () => {
  it("the anonymous forks list shows the public fork with its owner prefix, not the private one", async () => {
    await ensureWave24Fixtures();
    const res = await fetchUi("/wave24-owner/paint/forks");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository forks"');
    expect(html).toContain('<h2 class="ui dividing header">Forks</h2>');
    expect(html).toContain('href="/wave24-out"');
    expect(html).toContain('href="/wave24-out/paint-fork"');
    expect(html).not.toContain('href="/wave24-out/paint-hidden"');
  });

  it("the private fork renders for the doer who owns it (the listForks accessible-condition)", async () => {
    const fixture = await ensureWave24Fixtures();
    const res = await fetchUi("/wave24-owner/paint/forks", withCookie("/wave24-owner/paint/forks", fixture.outCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wave24-out/paint-fork"');
    expect(html).toContain('href="/wave24-out/paint-hidden"');
    expect(html).toContain("Private");
  });

  it("the stars page carries the watchers discriminator (tplWatchers serves both) and the starrers", async () => {
    await ensureWave24Fixtures();
    const res = await fetchUi("/wave24-owner/paint/stars");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository watchers"');
    expect(html).toContain("Stargazers");
    expect(html).toContain('href="/wave24-owner"');
    expect(html).toContain('href="/wave24-collab"');
    // The read-only collaborator never starred — no CARD anchor (the header
    // breadcrumb shape, as above).
    expect(html).not.toContain('<h3 class="name flex-text-block"><a href="/wave24-read">');
  });

  it("the watchers page lists the watchers", async () => {
    await ensureWave24Fixtures();
    const res = await fetchUi("/wave24-owner/paint/watchers");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository watchers"');
    expect(html).toContain("Watchers");
    expect(html).toContain('href="/wave24-collab"');
    expect(html).toContain('href="/wave24-read"');
    // The owner watched nothing — no CARD anchor (the repo header's
    // breadcrumb anchor always carries the owner namespace).
    expect(html).not.toContain('<h3 class="name flex-text-block"><a href="/wave24-owner">');
  });

  it("unknown repos and deeper tails 404", async () => {
    await ensureWave24Fixtures();
    expect((await fetchUi("/wave24-nobody/nothing/forks")).status).toBe(404);
    expect((await fetchUi("/wave24-owner/paint/forks/extra")).status).toBe(404);
    expect((await fetchUi("/wave24-owner/paint/stars/list")).status).toBe(404);
  });
});

// --- the collaboration panel -------------------------------------------------------

describe("collaboration panel /{owner}/{repo}/settings/collaboration", () => {
  it("anonymous 303s onto the login round-trip; a signed-in non-admin 404-shells", async () => {
    const fixture = await ensureWave24Fixtures();
    const anon = await fetchUi("/wave24-owner/paint/settings/collaboration");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/wave24-owner/paint/settings/collaboration")}`,
    );
    const outsider = await fetchUi(
      "/wave24-owner/paint/settings/collaboration",
      withCookie("/wave24-owner/paint/settings/collaboration", fixture.outCookie),
    );
    expect(outsider.status).toBe(404);
  });

  it("the repo owner sees the collaborators, the add form, and no Teams section (user-owned repo)", async () => {
    const fixture = await ensureWave24Fixtures();
    const res = await fetchUi(
      "/wave24-owner/paint/settings/collaboration",
      withCookie("/wave24-owner/paint/settings/collaboration", fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository settings collaboration"');
    expect(html).toContain("Collaborators");
    expect(html).toContain('href="/wave24-collab"');
    expect(html).toContain('href="/wave24-read"');
    expect(html).toContain('id="repo-collab-form"');
    expect(html).toContain("Add Collaborator");
    expect(html).not.toContain("Teams</h4>");
  });

  it("the org owner sees the Teams section with the covering team and the add-team form", async () => {
    await ensureWave24Fixtures();
    const fixture = await ensureWave24Fixtures();
    const res = await fetchUi(
      "/wave24org/project/settings/collaboration",
      withCookie("/wave24org/project/settings/collaboration", fixture.orgOwnerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Teams</h4>");
    expect(html).toContain("Committee");
    expect(html).toContain('id="repo-collab-team-form"');
    expect(html).toContain("Add Team");
  });

  it("a repo admin without the org's team-access flag sees the restricted note, not the team form", async () => {
    const fixture = await ensureWave24Fixtures();
    const res = await fetchUi(
      "/wave24org/project/settings/collaboration",
      withCookie("/wave24org/project/settings/collaboration", fixture.collabCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Changing team access for repository has been restricted to organization owner");
    expect(html).not.toContain('id="repo-collab-team-form"');
    // The team rows still render (upstream renders the list to everyone).
    expect(html).toContain("Committee");
  });
});

// --- the collaboration writes ------------------------------------------------------

describe("collaboration writes", () => {
  const paintPath = "/wave24-owner/paint/settings/collaboration";

  it("the add write 303s and renders the new collaborator; the duplicate refusal re-renders at 200", async () => {
    const fixture = await ensureWave24Fixtures();
    const added = await fetchUi(paintPath, formPost({ collaborator: "wave24-out" }, fixture.ownerCookie));
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe(paintPath);
    const after = await fetchUi(paintPath, withCookie(paintPath, fixture.ownerCookie));
    expect(await after.text()).toContain('href="/wave24-out"');

    const duplicate = await fetchUi(paintPath, formPost({ collaborator: "wave24-out" }, fixture.ownerCookie));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toContain("The collaborator is already added to this repository.");

    const missing = await fetchUi(paintPath, formPost({ collaborator: "wave24-nobody" }, fixture.ownerCookie));
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain("The user does not exist.");
  });

  it("the owner-themself add redirects silently (upstream's no-op arm)", async () => {
    const fixture = await ensureWave24Fixtures();
    const self = await fetchUi(paintPath, formPost({ collaborator: "wave24-owner" }, fixture.ownerCookie));
    expect(self.status).toBe(303);
    expect(await findCollaborator(env.DB, fixture.paintId, fixture.outId)).not.toBeNull(); // the earlier add survives
    const ownerRow = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, "wave24-owner"))
      .get();
    expect(await findCollaborator(env.DB, fixture.paintId, ownerRow!.id)).toBeNull();
  });

  it("the access_mode write flips the stored mode", async () => {
    const fixture = await ensureWave24Fixtures();
    const res = await fetchUi(
      `${paintPath}/access_mode`,
      formPost({ uid: String(fixture.outId), mode: "read" }, fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    const row = await findCollaborator(env.DB, fixture.paintId, fixture.outId);
    expect(row?.mode).toBe("read");
    const junk = await fetchUi(
      `${paintPath}/access_mode`,
      formPost({ uid: String(fixture.outId), mode: "owner" }, fixture.ownerCookie),
    );
    expect(junk.status).toBe(200);
    expect((await findCollaborator(env.DB, fixture.paintId, fixture.outId))?.mode).toBe("read");
  });

  it("the delete write removes the collaboration and is idempotent for absent rows", async () => {
    const fixture = await ensureWave24Fixtures();
    const res = await fetchUi(`${paintPath}/delete`, formPost({ id: String(fixture.outId) }, fixture.ownerCookie));
    expect(res.status).toBe(303);
    expect(await findCollaborator(env.DB, fixture.paintId, fixture.outId)).toBeNull();
    const again = await fetchUi(`${paintPath}/delete`, formPost({ id: String(fixture.outId) }, fixture.ownerCookie));
    expect(again.status).toBe(303);
  });

  it("the team add write covers the repo; the duplicate and unknown-team refusals re-render", async () => {
    const fixture = await ensureWave24Fixtures();
    const projectPath = "/wave24org/project/settings/collaboration";
    const added = await fetchUi(`${projectPath}/team`, formPost({ team: "Guild" }, fixture.orgOwnerCookie));
    expect(added.status).toBe(303);
    const after = await fetchUi(projectPath, withCookie(projectPath, fixture.orgOwnerCookie));
    expect((await after.text())).toContain("Guild");

    const duplicate = await fetchUi(`${projectPath}/team`, formPost({ team: "Committee" }, fixture.orgOwnerCookie));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toContain("Team already has the repository");

    const missing = await fetchUi(`${projectPath}/team`, formPost({ team: "ghost-team" }, fixture.orgOwnerCookie));
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain("The team does not exist.");
  });

  it("the team delete write uncovers the repo", async () => {
    const fixture = await ensureWave24Fixtures();
    const projectPath = "/wave24org/project/settings/collaboration";
    const res = await fetchUi(
      `${projectPath}/team/delete`,
      formPost({ id: String(fixture.guildTeamId) }, fixture.orgOwnerCookie),
    );
    expect(res.status).toBe(303);
    const after = await fetchUi(projectPath, withCookie(projectPath, fixture.orgOwnerCookie));
    expect(await after.text()).not.toContain("Guild");
  });

  it("the team writes 404-shell for a repo admin without the manage grant", async () => {
    const fixture = await ensureWave24Fixtures();
    const projectPath = "/wave24org/project/settings/collaboration";
    const add = await fetchUi(`${projectPath}/team`, formPost({ team: "Guild" }, fixture.collabCookie));
    expect(add.status).toBe(404);
    const del = await fetchUi(`${projectPath}/team/delete`, formPost({ id: "1" }, fixture.collabCookie));
    expect(del.status).toBe(404);
  });

  it("the POST-only write tails answer GET with 405", async () => {
    await ensureWave24Fixtures();
    expect((await fetchUi("/wave24-owner/paint/settings/collaboration/access_mode")).status).toBe(405);
    expect((await fetchUi("/wave24-owner/paint/settings/collaboration/delete")).status).toBe(405);
    expect((await fetchUi("/wave24-owner/paint/settings/collaboration/team")).status).toBe(405);
    expect((await fetchUi("/wave24-owner/paint/settings/collaboration/team/delete")).status).toBe(405);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-24 a11y smoke", () => {
  it("the new renders pass the structural rules", async () => {
    const fixture = await ensureWave24Fixtures();
    for (const [path, init] of [
      ["/wave24-owner/paint/forks", undefined],
      ["/wave24-owner/paint/forks", withCookie("/wave24-owner/paint/forks", fixture.outCookie)],
      ["/wave24-owner/paint/stars", undefined],
      ["/wave24-owner/paint/watchers", undefined],
      ["/wave24-owner/paint/settings/collaboration", withCookie("/wave24-owner/paint/settings/collaboration", fixture.ownerCookie)],
      ["/wave24org/project/settings/collaboration", withCookie("/wave24org/project/settings/collaboration", fixture.orgOwnerCookie)],
      [
        "/wave24org/project/settings/collaboration",
        withCookie("/wave24org/project/settings/collaboration", fixture.collabCookie),
      ],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});

// --- w129 additions (wave-polish-matrix-6, 2026-10-27) ---------------------------
// The social lists' deepening: the collaborator rung of the visibility ladder,
// the watchers pager's pageSize boundary and past-the-end arms. Provenance in
// the file header. The w129 rows ride their own lazy-guarded repos (a private
// vault + a 40-watcher bulk repo created below — wave24's fixture owns no
// private repo, and the fsx names live in the other file), so nothing the
// wave-24 arms assert is disturbed.

let w129VaultReady = false;
let w129BulkReady = false;

/** The w129 private repo (wave24-owner/w129-vault) — the ladder's private rung
 *  population; wave24-read is granted READ on it on first call. */
async function ensureW129Vault(): Promise<void> {
  if (w129VaultReady) return;
  await ensureWave24Fixtures();
  const owner = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "wave24-owner"))
    .get();
  const reader = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "wave24-read"))
    .get();
  if (owner === undefined || reader === undefined) throw new Error("w129 owner/reader rows missing");
  const service = new RepoService(env.DB);
  const vault = await service.create({
    owner: { id: owner.id, usernameLower: "wave24-owner" },
    name: "w129-vault",
    isPrivate: true,
    status: "ready",
  });
  await addOrUpdateCollaborator(env.DB, vault.id, reader.id, "read", new Date(1_700_000_000 * 1000));
  w129VaultReady = true;
}

/** User-card count: the `li.item.ui.segment` roots (the same shape key the
 *  forks matrix's cardRowCount uses — the shell emits no other li.ui.segment). */
function cardCount(html: string): number {
  return (html.match(/<li class="item ui segment">/g) ?? []).length;
}

/** Seed exactly pageSize (40) watchers onto the w129 bulk repo: the five
 *  wave-24 users plus 35 fresh ones — the boundary population for the pager
 *  arms. */
async function ensureW129Bulk(): Promise<string> {
  if (w129BulkReady) {
    const existing = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "wave24-owner"), eq(repositories.slug, "w129-bulk")))
      .get();
    if (existing === undefined) throw new Error("w129 bulk row missing on re-entry");
    return existing.id;
  }
  await ensureWave24Fixtures();
  const owner = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "wave24-owner"))
    .get();
  if (owner === undefined) throw new Error("w129 owner row missing");
  const service = new RepoService(env.DB);
  const bulk = await service.create({
    owner: { id: owner.id, usernameLower: "wave24-owner" },
    name: "w129-bulk",
    isPrivate: false,
    status: "ready",
  });
  const now = new Date(1_700_000_000 * 1000);
  // The five existing users (owner, collab, read, out, orgowner)…
  for (const name of ["wave24-owner", "wave24-collab", "wave24-read", "wave24-out", "wave24-orgowner"]) {
    const row = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, name))
      .get();
    if (row !== undefined) await watchRepo(env.DB, bulk.id, row.id, now);
  }
  // …plus 35 fresh ones → exactly 40 watchers.
  for (let i = 1; i <= 35; i++) {
    const user = await seedVerifiedUser({ username: `wave129w-${String(i).padStart(2, "0")}` });
    await watchRepo(env.DB, bulk.id, user.id, now);
  }
  w129BulkReady = true;
  return bulk.id;
}

describe("w129 the trio's collaborator rung (the read grant's collaborator arm at the page level)", () => {
  it("a READ collaborator renders the private repo's whole trio; the ladder stays anon < stranger < collaborator < owner/admin", async () => {
    // Provenance: wave-polish-matrix-6. wave24's gates ran on a public trio,
    // and the fsx matrix pinned anon/stranger/owner/admin — the COLLABORATOR
    // rung (acl.ts readGrant's any-row-grants-read arm, the same grant the
    // git-HTTP clone pins) was unpinned at the trio's page level.
    await ensureW129Vault();
    const fixture = await ensureWave24Fixtures();

    for (const family of ["forks", "stars", "watchers"] as const) {
      const res = await fetchUi(`/wave24-owner/w129-vault/${family}`, withCookie(`/x`, fixture.readCookie));
      expect(res.status, family).toBe(200);
      const html = await res.text();
      expect(html, family).toContain(`class="page-content repository ${family === "forks" ? "forks" : "watchers"}"`);
      // The private repo's own empty listings render (no MustBeNotEmpty gate).
      expect(html, family).not.toContain("status-page-error");
    }
    // The ladder's floor holds one rung up: the anonymous viewer still 404s.
    expect((await fetchUi("/wave24-owner/w129-vault/forks")).status).toBe(404);
  });
});

describe("w129 the watchers pager's pageSize boundary and past-the-end arms", () => {
  it("exactly 40 watchers fill page 1 with NO pager (total == page*ItemsPerPage → no Older), and ?page=2 renders the bare empty ul with the Newer link", async () => {
    // Provenance: wave-polish-matrix-6. The forks pager's 41-row boundary is
    // the fsx matrix's; the watchers page (the SAME SOCIAL_PAGE_SIZE pager
    // over a different listing) never had a pager test at all — this pins
    // the exact-boundary arm (a full page does NOT offer an Older link) and
    // the org-home pagination's bare-canonical Newer href at page 2.
    await ensureW129Bulk();
    const first = await fetchUi("/wave24-owner/w129-bulk/watchers");
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(cardCount(firstHtml)).toBe(40);
    expect(firstHtml).toContain("Watchers");
    expect(firstHtml).not.toContain("<span class=\"navigation_label\">"); // page 1 + !more → no pager

    const second = await fetchUi("/wave24-owner/w129-bulk/watchers?page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(cardCount(secondHtml)).toBe(0);
    // The user_cards template has NO else arm upstream — the bare empty ul,
    // NOT the forks family's no-results line.
    expect(secondHtml).not.toContain("No matching results found.");
    // Newer onto page 1 carries the bare canonical href (page 2 → page>2 is
    // false, the org-home pager drops the param).
    expect(secondHtml).toContain('<a class="item navigation" href="/wave24-owner/w129-bulk/watchers">');
    expect(secondHtml).toContain("<span class=\"navigation_label\">Newer</span>");
    expect(secondHtml).not.toContain(">Older</span>");
  });

  it("the stargazers' past-the-end arm: a bare empty ul beside the Newer pager, never the no-results line (the forks differential)", async () => {
    // Provenance: wave-polish-matrix-6. The fsx matrix pins forks?page=99
    // rendering "No matching results found." — this pins the stars twin:
    // 45 stargazers, page 99, the same fork-list vs user-cards empty-shape
    // divergence at the router level.
    await ensureWave24Fixtures();
    const far = await fetchUi("/wave24-owner/paint/stars?page=99");
    expect(far.status).toBe(200);
    const farHtml = await far.text();
    expect(cardCount(farHtml)).toBe(0);
    expect(farHtml).not.toContain("No matching results found.");
    // Newer points one page back (99 → 98); no Older (page 99 still holds
    // no rows beyond the 45).
    expect(farHtml).toContain('<a class="item navigation" href="/wave24-owner/paint/stars?page=98">');
    expect(farHtml).toContain("<span class=\"navigation_label\">Newer</span>");
    expect(farHtml).not.toContain(">Older</span>");
  });
});
