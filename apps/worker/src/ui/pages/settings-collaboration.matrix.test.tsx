/**
 * The repo SETTINGS COLLABORATION page's deferred route-level matrix
 * (pages/settings-collaboration.tsx — upstream web.go:1194-1204's group,
 * mounted since wave 24). The early suite owns the base arms and THIS FILE
 * does not repeat them (apps/worker/src/ui/__tests__/pages-wave24.test.ts):
 *
 *   - the parser claims for the five families + the `collaboration/other`
 *     and `/collaborate` negatives;
 *   - the anonymous GET 303 round-trip and the outsider's 404 shell;
 *   - the owner GET (collaborators + add form, no Teams section on a
 *     user-owned repo), the org owner's Teams section, and the
 *     flag=FALSE restricted note for the admin collaborator;
 *   - the add write's happy path + duplicate/unknown refusals, the
 *     owner-themself silent arm, the access_mode read flip + junk-mode
 *     refusal, the delete write + its idempotence, the team add/delete
 *     round-trips with their duplicate/unknown refusals, the team writes'
 *     404 for an admin without the manage grant, the GET-405 split, and
 *     the §5.5 a11y smoke.
 *
 * THIS FILE adds the arms that suite cannot reach, driven over the mounted
 * uiRouter with the tree-view a9ff253 minted-session pattern (per-test
 * reseed — the settings-basics matrix's beforeEach wipe):
 *
 *   - the WRITE-time gate posture: an anonymous same-origin POST 303s onto
 *     the login round-trip before any write, a signed-in write COLLABORATOR
 *     (admin-less) 404-shells every write tail with D1 untouched, and the
 *     no-Origin/no-Referer POST passes the §2.8 layer-2 guard (absent
 *     headers are not evidence — the write applies);
 *   - the cross-origin 403 on ALL FIVE write tails, guard-first, with
 *     per-arm D1 read-backs proving nothing was written — plus the
 *     Referer-fallback arm (cross-origin Referer, no Origin header);
 *   - the add-collaborator refusal ladder's MISSING arms, upstream's exact
 *     order and flash texts: the empty/whitespace silent redirects, the
 *     kept submission on refusal, the inactive (prohibited) user, the
 *     organization-as-collaborator refusal, the org-owner refusal, BOTH
 *     directions of the user_blocking refusal, and the trim+case-fold
 *     normalization of the submitted name;
 *   - the access-mode write's remaining arms: the admin flip (render
 *     `selected` + D1 read-back) and the junk-uid family; plus one
 *     [RED — ESCALATED] probe: an unknown-but-positive uid is the
 *     DOCUMENTED refused arm (upstream GetUserByID fails → Status(400),
 *     nothing written; the module header promises the refusal) but the
 *     handler upserts an orphan repo_collaborators row and 303s — see the
 *     test's comment for the escalation evidence;
 *   - the remove write's refused arms (junk id, unknown user id) and the
 *     render side of the round-trip (the row unlists);
 *   - the team-write gate spread: team tails on a USER-owned repo 404-shell
 *     even for the owner (CanDoerManageOrgRepoCollaboratorTeam is
 *     org-gated), and the repo_admin_change_team_access=TRUE arm — the
 *     admin collaborator gains the form, the per-team Remove buttons and
 *     the working add/delete writes (wave 24 pinned only the flag=false
 *     note); the empty-team silent arm, the unknown/junk team-delete
 *     refusals, the not-covering delete's silent no-op and the
 *     includes-all team's disabled button + route-level no-op;
 *   - the panel's team render contract: the teamModeText ladder
 *     (Read/Write/Administrator/Unit Permissions/Owner) and the units_map
 *     Units lines (mapped keys, a raw unknown key, the empty `[]` → None);
 *   - the collaborator row render: the select reflects the stored mode and
 *     DisplayNameWithFullName renders `username (Full Name)`;
 *   - the claim pin: the .git-trimmed repo segment claims into the family
 *     (parse + route level) and the deeper/junk tails stay engine-owned.
 *
 * Pending invitations: upstream's collaboration.tmpl renders a pending-
 * invitation notice only behind an invitation flow — NO invitation model
 * has landed in this repo (no service, no table, no route), so that arm is
 * N/A here by construction.
 *
 * Fixtures (unique `scm-*` names, per-test reseed through the landed
 * services — D1-only, no engine content): `scm-owner/scm-paint` (user-owned,
 * write collaborator scm-collab + read collaborator scm-read), `scm-org/
 * scm-project` (org-owned; Readers covers it, Guild does not, plus the
 * units/includes-all/ladder teams), identities riding per-request minted
 * session cookies, POSTs carrying the same-origin Origin header.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addOrUpdateCollaborator, findCollaborator } from "../../api/services/repo-collaborators";
import { TeamsService, type TeamRecord } from "../../api/routes/org-teams";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { teams, userBlocking, users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";

// --- fixtures (per-test reseed, the settings-basics matrix's pattern) -----------

const ORIGIN = "https://test.local";
const PAINT_PATH = "/scm-owner/scm-paint/settings/collaboration";
const PROJECT_PATH = "/scm-org/scm-project/settings/collaboration";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

interface ScmFixture {
  ownerId: number;
  collabId: number;
  readId: number;
  goneId: number;
  orgOwnerId: number;
  adminId: number;
  orgId: number;
  paint: RepoRow;
  project: RepoRow;
  readers: TeamRecord; // covers project (read)
  scribes: TeamRecord; // covers project (write) — the ladder's Write arm
  guild: TeamRecord; // covers nothing
  includesAll: TeamRecord; // includes-all (read)
  units: TeamRecord; // units_map → "Unit Permissions" + "Units: Code, Wiki"
  rawUnits: TeamRecord; // units_map with an unknown key → the raw-key Units line
  emptyUnits: TeamRecord; // units_map '[]' → the "Units: None" arm
  elevated: TeamRecord; // authorize admin → "Administrator"
  root: TeamRecord; // authorize 'owner' (direct row update) → "Owner"
}

let fx: ScmFixture;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // Children before parents (the leaf tables carry the FKs; repositories and
  // repo_collaborators are FK-free per the repo-scoped-table convention, but
  // repo_counters references repositories with NO cascade).
  for (const table of [
    "repo_collaborators",
    "team_repo_access",
    "team_members",
    "teams",
    "org_members",
    "user_blocking",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  fx = await seedScm();
});

async function seedScm(): Promise<ScmFixture> {
  const owner = await seedVerifiedUser({ username: "scm-owner" });
  const collab = await seedVerifiedUser({ username: "scm-collab" });
  const read = await seedVerifiedUser({ username: "scm-read" });
  const gone = await seedVerifiedUser({ username: "scm-gone", status: "prohibited" });
  const orgOwner = await seedVerifiedUser({ username: "scm-orgowner" });
  const admin = await seedVerifiedUser({ username: "scm-admin" });

  const now = new Date(1_700_000_000 * 1000);
  const service = new RepoService(env.DB);
  const paint = await service.create({
    owner: { id: owner.id, usernameLower: "scm-owner" },
    name: "scm-paint",
    isPrivate: false,
    status: "ready",
  });
  await addOrUpdateCollaborator(env.DB, paint.id, collab.id, "write", now);
  await addOrUpdateCollaborator(env.DB, paint.id, read.id, "read", now);

  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({
    name: "scm-org",
    ownerId: orgOwner.id,
    visibility: "public",
    fullName: "Scm Org",
    now,
  });
  const project = await service.create({
    owner: { id: org.id, usernameLower: "scm-org" },
    name: "scm-project",
    isPrivate: false,
    status: "ready",
  });
  await addOrUpdateCollaborator(env.DB, project.id, admin.id, "admin", now);

  const teamService = new TeamsService(env.DB);
  // The panel lists the repo's COVERING teams (upstream GetRepoTeams), so
  // every render-contract team is covered with addTeamRepo; Guild stays
  // uncovered — the not-covering delete arm's target and the flag-arm add's
  // target.
  const readers = await teamService.createTeam(org, { name: "Readers", permission: "read" });
  await teamService.addTeamRepo(readers, project.id);
  const guild = await teamService.createTeam(org, { name: "Guild", permission: "write" });
  const scribes = await teamService.createTeam(org, { name: "Scribes", permission: "write" });
  await teamService.addTeamRepo(scribes, project.id);
  const includesAll = await teamService.createTeam(org, {
    name: "AllRepos",
    permission: "read",
    includes_all_repositories: true,
  });
  const units = await teamService.createTeam(org, {
    name: "UnitFolk",
    permission: "read",
    units_map: { "repo.code": "read", "repo.wiki": "read" },
  });
  await teamService.addTeamRepo(units, project.id);
  const rawUnits = await teamService.createTeam(org, {
    name: "RawFolk",
    permission: "read",
    units_map: { "repo.custom": "write" },
  });
  await teamService.addTeamRepo(rawUnits, project.id);
  const elevated = await teamService.createTeam(org, { name: "Elevated", permission: "admin" });
  await teamService.addTeamRepo(elevated, project.id);
  const root = await teamService.createTeam(org, { name: "RootFolk", permission: "admin" });
  await teamService.addTeamRepo(root, project.id);
  // The API enum never writes 'owner' (ParseAccessMode); the ladder's owner
  // arm is seeded by the direct row update the column's value space allows.
  await drizzle(env.DB).update(teams).set({ authorize: "owner" }).where(eq(teams.id, root.id));
  const emptyUnits = await teamService.createTeam(org, { name: "EmptyFolk", permission: "read" });
  await teamService.addTeamRepo(emptyUnits, project.id);
  await drizzle(env.DB).update(teams).set({ unitsMap: "[]" }).where(eq(teams.id, emptyUnits.id));

  return {
    ownerId: owner.id,
    collabId: collab.id,
    readId: read.id,
    goneId: gone.id,
    orgOwnerId: orgOwner.id,
    adminId: admin.id,
    orgId: org.id,
    paint,
    project,
    readers,
    scribes,
    guild,
    includesAll,
    units,
    rawUnits,
    emptyUnits,
    elevated,
    root,
  };
}

// --- the mounted-route harness (the tree-view a9ff253 minted-session pattern) ----

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the gates → the
 *  handler, on the mounted uiRouter with the synthetic manifest; the
 *  execution context is awaited so waitUntil side-effects settle. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user id (the real mintSession
 *  path, minted per request — the beforeEach users wipe cascades sessions;
 *  the value is never rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The urlencoded POST to a collaboration tail. The Origin header is the
 *  same-origin default; `origin` overrides it (the cross-origin 403 arms),
 *  `referer` exercises the guard's fallback (with `bare`), and `bare` alone
 *  drops both (the non-browser posture layer 2 passes through). `cookie`
 *  is the full session HEADER (the sessionHeader helper's shape), or null
 *  for the anonymous arm. */
function formPost(
  body: Record<string, string>,
  cookie: Promise<string> | null,
  opts: { origin?: string; referer?: string; bare?: boolean } = {},
): Promise<RequestInit> {
  return (cookie ?? Promise.resolve(null)).then((cookieHeader) => {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (cookieHeader !== null) headers.cookie = cookieHeader;
    if (opts.bare !== true) headers.origin = opts.origin ?? ORIGIN;
    if (opts.referer !== undefined) headers.referer = opts.referer;
    return { method: "POST", headers, body: new URLSearchParams(body).toString() };
  });
}

/** One team row's slice of the panel: from the team's id-keyed anchor to the
 *  next team anchor (TeamRow renders `/{org}/teams/{id}`), so the per-team
 *  mode text and Units line are asserted without cross-row collisions. */
function teamChunk(html: string, teamId: number): string {
  const marker = `/scm-org/teams/${teamId}`;
  const start = html.indexOf(marker);
  if (start === -1) return "";
  const next = html.indexOf('class="item-title tw-text-primary"', start);
  return html.slice(start, next === -1 ? undefined : next);
}

// --- the write-time gate posture (the settingsGate fronts every POST) -----------

describe("the write-time gate posture (settingsGate before any write)", () => {
  it("an anonymous same-origin POST 303s onto the login round-trip; nothing was written", async () => {
    const res = await fetchUi(PAINT_PATH, await formPost({ collaborator: "scm-gone" }, null));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(PAINT_PATH)}`);
    expect(await findCollaborator(env.DB, fx.paint.id, fx.goneId)).toBeNull();
  });

  it("a signed-in write COLLABORATOR (admin-less) 404-shells the add write before it lands", async () => {
    const res = await fetchUi(
      PAINT_PATH,
      await formPost({ collaborator: "scm-gone" }, sessionHeader(fx.collabId)),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await findCollaborator(env.DB, fx.paint.id, fx.goneId)).toBeNull();
  });

  it("the same admin-less session 404-shells the access_mode and delete tails too (nothing moves)", async () => {
    const res = await fetchUi(
      `${PAINT_PATH}/access_mode`,
      await formPost({ uid: String(fx.readId), mode: "admin" }, sessionHeader(fx.collabId)),
    );
    expect(res.status).toBe(404);
    const del = await fetchUi(
      `${PAINT_PATH}/delete`,
      await formPost({ id: String(fx.readId) }, sessionHeader(fx.collabId)),
    );
    expect(del.status).toBe(404);
    expect((await findCollaborator(env.DB, fx.paint.id, fx.readId))?.mode).toBe("read");
  });

  it("a POST with NO Origin and NO Referer passes the §2.8 guard (absent headers are not evidence) and the write applies", async () => {
    const res = await fetchUi(
      PAINT_PATH,
      await formPost({ collaborator: "scm-orgowner" }, sessionHeader(fx.ownerId), { bare: true }),
    );
    expect(res.status).toBe(303);
    expect(await findCollaborator(env.DB, fx.paint.id, fx.orgOwnerId)).not.toBeNull();
  });
});

// --- the cross-origin 403 (§2.8 layer 2, guard-first on every write tail) --------

describe("the cross-origin 403 (sameOriginGuard first on all five write tails)", () => {
  it("403s the add write in plain text before any write", async () => {
    const res = await fetchUi(
      PAINT_PATH,
      await formPost({ collaborator: "scm-gone" }, sessionHeader(fx.ownerId), { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await findCollaborator(env.DB, fx.paint.id, fx.goneId)).toBeNull();
  });

  it("403s the access_mode, delete, team and team/delete tails with D1 untouched", async () => {
    const cookie = sessionHeader(fx.ownerId);
    const beforeRead = await findCollaborator(env.DB, fx.paint.id, fx.readId);
    const beforeCollab = await findCollaborator(env.DB, fx.paint.id, fx.collabId);

    const mode = await fetchUi(
      `${PAINT_PATH}/access_mode`,
      await formPost({ uid: String(fx.readId), mode: "admin" }, cookie, { origin: "https://evil.example" }),
    );
    expect(mode.status).toBe(403);
    expect(await findCollaborator(env.DB, fx.paint.id, fx.readId)).toEqual(beforeRead);

    const del = await fetchUi(
      `${PAINT_PATH}/delete`,
      await formPost({ id: String(fx.collabId) }, cookie, { origin: "https://evil.example" }),
    );
    expect(del.status).toBe(403);
    expect(await findCollaborator(env.DB, fx.paint.id, fx.collabId)).toEqual(beforeCollab);

    const teamAdd = await fetchUi(
      `${PROJECT_PATH}/team`,
      await formPost({ team: "Guild" }, sessionHeader(fx.orgOwnerId), { origin: "https://evil.example" }),
    );
    expect(teamAdd.status).toBe(403);
    const teamDel = await fetchUi(
      `${PROJECT_PATH}/team/delete`,
      await formPost({ id: String(fx.readers.id) }, sessionHeader(fx.orgOwnerId), { origin: "https://evil.example" }),
    );
    expect(teamDel.status).toBe(403);

    // The org coverage stands untouched (Readers still listed after both).
    const panel = await fetchUi(PROJECT_PATH, { headers: { cookie: await sessionHeader(fx.orgOwnerId) } });
    expect(teamChunk(await panel.text(), fx.readers.id)).toContain("Readers");
  });

  it("a cross-origin Referer with NO Origin header 403s too (the guard's fallback arm)", async () => {
    const res = await fetchUi(
      PAINT_PATH,
      await formPost({ collaborator: "scm-gone" }, sessionHeader(fx.ownerId), {
        bare: true,
        referer: "https://evil.example/attack",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await findCollaborator(env.DB, fx.paint.id, fx.goneId)).toBeNull();
  });
});

// --- the add-collaborator refusal ladder (the arms wave 24 left open) -------------

describe("the add-collaborator refusal ladder (upstream CollaborationPost's order)", () => {
  it("an empty and a whitespace-only name redirect silently (upstream's no-op arm)", async () => {
    const cookie = sessionHeader(fx.ownerId);
    const empty = await fetchUi(PAINT_PATH, await formPost({ collaborator: "" }, cookie));
    expect(empty.status).toBe(303);
    expect(empty.headers.get("location")).toBe(PAINT_PATH);
    const blank = await fetchUi(PAINT_PATH, await formPost({ collaborator: "   " }, cookie));
    expect(blank.status).toBe(303);
  });

  it("an unknown user re-renders with the exact text and the KEPT submission", async () => {
    const res = await fetchUi(PAINT_PATH, await formPost({ collaborator: "scm-nobody" }, sessionHeader(fx.ownerId)));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">The user does not exist.</div>');
    expect(html).toContain('value="scm-nobody"'); // the carried submission
  });

  it("an inactive (prohibited) user is refused with the inactive text", async () => {
    const res = await fetchUi(PAINT_PATH, await formPost({ collaborator: "scm-gone" }, sessionHeader(fx.ownerId)));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Cannot add an inactive user as a collaborator.");
    expect(await findCollaborator(env.DB, fx.paint.id, fx.goneId)).toBeNull();
  });

  it("an ORGANIZATION name is refused as a collaborator (on the user-owned repo, so the silent self arm cannot shadow it)", async () => {
    const res = await fetchUi(PAINT_PATH, await formPost({ collaborator: "scm-org" }, sessionHeader(fx.ownerId)));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Organizations cannot be added as a collaborator.");
    const orgRow = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, "scm-org"))
      .get();
    expect(orgRow).toBeDefined();
    expect(await findCollaborator(env.DB, fx.paint.id, orgRow!.id)).toBeNull();
  });

  it("the ORG's OWNER user is refused on the org-owned repo (after the duplicate check, upstream's order)", async () => {
    const res = await fetchUi(PROJECT_PATH, await formPost({ collaborator: "scm-orgowner" }, sessionHeader(fx.orgOwnerId)));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Cannot add an owner as a collaborator.");
    expect(await findCollaborator(env.DB, fx.project.id, fx.orgOwnerId)).toBeNull();
  });

  it("a target blocked BY the repo owner is refused with the blocked text", async () => {
    // scm-orgowner: active, NOT yet a collaborator, and the org-owner arm is
    // skipped on a user-owned repo — the only roster user that reaches the
    // blocked check (the inactive/duplicate arms front it, upstream's order).
    await drizzle(env.DB).insert(userBlocking).values({
      blockerId: fx.ownerId,
      blockeeId: fx.orgOwnerId,
      note: "",
      createdAt: new Date(),
    });
    const res = await fetchUi(PAINT_PATH, await formPost({ collaborator: "scm-orgowner" }, sessionHeader(fx.ownerId)));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The collaborator is blocked by the repository owner or vice versa.");
    expect(await findCollaborator(env.DB, fx.paint.id, fx.orgOwnerId)).toBeNull();
  });

  it("a target who blocked the REPO OWNER is refused the same way (the ErrBlockedUser pair's second direction)", async () => {
    await drizzle(env.DB).insert(userBlocking).values({
      blockerId: fx.orgOwnerId,
      blockeeId: fx.ownerId,
      note: "",
      createdAt: new Date(),
    });
    const res = await fetchUi(PAINT_PATH, await formPost({ collaborator: "scm-orgowner" }, sessionHeader(fx.ownerId)));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The collaborator is blocked by the repository owner or vice versa.");
    expect(await findCollaborator(env.DB, fx.paint.id, fx.orgOwnerId)).toBeNull();
  });

  it("the submitted name is trimmed and case-folded before the lookup (a padded MIXED-CASE name lands)", async () => {
    const res = await fetchUi(
      PAINT_PATH,
      await formPost({ collaborator: "  SCM-OrgOwner " }, sessionHeader(fx.ownerId)),
    );
    expect(res.status).toBe(303);
    const row = await findCollaborator(env.DB, fx.paint.id, fx.orgOwnerId);
    expect(row?.mode).toBe("write"); // the add write's default mode
  });
});

// --- the access-mode write (admin flip, junk uid, the escalated unknown uid) ------

describe("the access-mode write's remaining arms", () => {
  it("flips read → admin: the select's selected attribute follows and D1 agrees", async () => {
    const res = await fetchUi(
      `${PAINT_PATH}/access_mode`,
      await formPost({ uid: String(fx.readId), mode: "admin" }, sessionHeader(fx.ownerId)),
    );
    expect(res.status).toBe(303);
    expect((await findCollaborator(env.DB, fx.paint.id, fx.readId))?.mode).toBe("admin");
    const panel = await fetchUi(PAINT_PATH, { headers: { cookie: await sessionHeader(fx.ownerId) } });
    expect(await panel.text()).toContain('<option value="admin" selected="">');
  });

  it("a junk uid (absent / non-numeric / zero / negative) re-renders refused and leaves the stored mode alone", async () => {
    const forms: Array<Record<string, string>> = [
      {},
      { uid: "abc", mode: "write" },
      { uid: "0", mode: "write" },
      { uid: "-3", mode: "write" },
    ];
    for (const form of forms) {
      const res = await fetchUi(`${PAINT_PATH}/access_mode`, await formPost(form, sessionHeader(fx.ownerId)));
      expect(res.status, JSON.stringify(form)).toBe(200);
      expect(await res.text(), JSON.stringify(form)).toContain("The user does not exist.");
      expect((await findCollaborator(env.DB, fx.paint.id, fx.readId))?.mode, JSON.stringify(form)).toBe("read");
    }
  });

  it("[RED — ESCALATED] an unknown-but-positive uid is the DOCUMENTED refused arm, not a silent orphan-row write", async () => {
    // pages/settings-collaboration.tsx's header: "An unknown uid or a junk
    // mode is the refused arm (upstream answers 400...)". Upstream
    // ChangeCollaborationAccessMode (routers/web/repo/setting/collaboration.go)
    // runs GetUserByID(uid) FIRST and answers Status(400) — nothing written —
    // for a uid that identifies no user. The landed handler only refuses
    // NaN/<= 0: a positive unknown uid falls through to addOrUpdateCollaborator,
    // which inserts an orphan repo_collaborators row (the table declares no
    // FK; the user_id keys no users row) and 303s. Observed 2026-10-26,
    // wave-polish-collaboration; escalated per the tests-only brief. The
    // sibling remove write in the same module DOES existence-check the id
    // (removeCollaboratorFromForm), so the asymmetry reads as an oversight.
    const res = await fetchUi(
      `${PAINT_PATH}/access_mode`,
      await formPost({ uid: "987654", mode: "write" }, sessionHeader(fx.ownerId)),
    );
    expect(res.status).toBe(200); // the documented refusal re-render — ACTUAL: 303
    expect(await findCollaborator(env.DB, fx.paint.id, 987654)).toBeNull(); // ACTUAL: orphan row
  });
});

// --- the remove write's refused arms + the render side of the round-trip ----------

describe("the remove write's refused arms and the render round-trip", () => {
  it("a junk id and an unknown USER id are refused with the user_not_exist text", async () => {
    const cookie = sessionHeader(fx.ownerId);
    const junk = await fetchUi(`${PAINT_PATH}/delete`, await formPost({ id: "abc" }, cookie));
    expect(junk.status).toBe(200);
    expect(await junk.text()).toContain("The user does not exist.");
    const unknown = await fetchUi(`${PAINT_PATH}/delete`, await formPost({ id: "999999" }, cookie));
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain("The user does not exist.");
  });

  it("after the delete write the row unlists and the surviving row stays", async () => {
    const cookie = { headers: { cookie: await sessionHeader(fx.ownerId) } };
    const before = await fetchUi(PAINT_PATH, cookie);
    expect(await before.text()).toContain('href="/scm-collab"');

    const del = await fetchUi(
      `${PAINT_PATH}/delete`,
      await formPost({ id: String(fx.collabId) }, sessionHeader(fx.ownerId)),
    );
    expect(del.status).toBe(303);

    const after = await fetchUi(PAINT_PATH, cookie);
    const html = await after.text();
    expect(html).not.toContain('href="/scm-collab"');
    expect(html).toContain('href="/scm-read"'); // the surviving row stays
    expect(html).toContain('id="repo-collab-form"'); // the add form remains
  });
});

// --- the team-write gate spread (the org gate + the flag=true arm) -----------------

describe("the team-write gate spread", () => {
  it("the team tails 404-shell on a USER-owned repo even for its owner (the manage grant is org-gated)", async () => {
    const cookie = sessionHeader(fx.ownerId);
    const add = await fetchUi(`${PAINT_PATH}/team`, await formPost({ team: "Guild" }, cookie));
    expect(add.status).toBe(404);
    expect(await add.text()).toContain("status-page-error");
    const del = await fetchUi(`${PAINT_PATH}/team/delete`, await formPost({ id: "1" }, cookie));
    expect(del.status).toBe(404);
  });

  it("the restricted admin (flag=false) sees no per-team Remove buttons either", async () => {
    const panel = await fetchUi(PROJECT_PATH, { headers: { cookie: await sessionHeader(fx.adminId) } });
    expect(panel.status).toBe(200);
    expect(await panel.text()).not.toContain("/settings/collaboration/team/delete");
  });

  it("the repo_admin_change_team_access=TRUE arm: the admin collaborator gains the form, the Remove buttons and the working writes", async () => {
    await drizzle(env.DB).update(users).set({ repoAdminChangeTeamAccess: true }).where(eq(users.id, fx.orgId));
    const cookie = { headers: { cookie: await sessionHeader(fx.adminId) } };

    const panel = await fetchUi(PROJECT_PATH, cookie);
    expect(panel.status).toBe(200);
    const html = await panel.text();
    expect(html).toContain('id="repo-collab-team-form"'); // the add-team form
    expect(html).toContain("/settings/collaboration/team/delete"); // the per-team Remove forms
    expect(html).not.toContain("Changing team access for repository has been restricted to organization owner");

    const add = await fetchUi(`${PROJECT_PATH}/team`, await formPost({ team: "Guild" }, sessionHeader(fx.adminId)));
    expect(add.status).toBe(303);
    const covered = await fetchUi(PROJECT_PATH, cookie);
    expect(await covered.text()).toContain("Guild");

    const del = await fetchUi(
      `${PROJECT_PATH}/team/delete`,
      await formPost({ id: String(fx.guild.id) }, sessionHeader(fx.adminId)),
    );
    expect(del.status).toBe(303);
    const uncovered = await fetchUi(PROJECT_PATH, cookie);
    expect(await uncovered.text()).not.toContain("Guild");
  });

  it("an empty team name redirects silently (upstream AddTeamPost's no-op arm)", async () => {
    const res = await fetchUi(`${PROJECT_PATH}/team`, await formPost({ team: "" }, sessionHeader(fx.orgOwnerId)));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(PROJECT_PATH);
  });

  it("the team-delete refusals: a junk id and an unknown TEAM id re-render the team_not_exist text", async () => {
    const cookie = sessionHeader(fx.orgOwnerId);
    const junk = await fetchUi(`${PROJECT_PATH}/team/delete`, await formPost({ id: "abc" }, cookie));
    expect(junk.status).toBe(200);
    expect(await junk.text()).toContain("The team does not exist.");
    const unknown = await fetchUi(`${PROJECT_PATH}/team/delete`, await formPost({ id: "999999" }, cookie));
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain("The team does not exist.");
  });

  it("removing a team that does NOT cover the repo is a silent no-op (upstream's own arm)", async () => {
    const res = await fetchUi(
      `${PROJECT_PATH}/team/delete`,
      await formPost({ id: String(fx.guild.id) }, sessionHeader(fx.orgOwnerId)),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(PROJECT_PATH);
  });

  it("the includes-all team renders a DISABLED Remove with the tooltip and the delete write no-ops on it", async () => {
    const cookie = { headers: { cookie: await sessionHeader(fx.orgOwnerId) } };
    const panel = await fetchUi(PROJECT_PATH, cookie);
    const chunk = teamChunk(await panel.text(), fx.includesAll.id);
    expect(chunk).toContain('disabled=""');
    expect(chunk).toContain("be removed"); // the delete_team_tip (apostrophe-escaped in the attribute)

    const del = await fetchUi(
      `${PROJECT_PATH}/team/delete`,
      await formPost({ id: String(fx.includesAll.id) }, sessionHeader(fx.orgOwnerId)),
    );
    expect(del.status).toBe(303);
    const after = await fetchUi(PROJECT_PATH, cookie);
    expect(teamChunk(await after.text(), fx.includesAll.id)).toContain("AllRepos"); // still covered
  });
});

// --- the panel's team render contract (the mode ladder + the Units lines) ---------

describe("the panel's team render contract", () => {
  it("the teamModeText ladder renders per stored authorize", async () => {
    const panel = await fetchUi(PROJECT_PATH, { headers: { cookie: await sessionHeader(fx.orgOwnerId) } });
    const html = await panel.text();
    expect(teamChunk(html, fx.readers.id)).toContain("Read</div>");
    expect(teamChunk(html, fx.scribes.id)).toContain("Write</div>");
    expect(teamChunk(html, fx.elevated.id)).toContain("Administrator</div>");
    expect(teamChunk(html, fx.units.id)).toContain("Unit Permissions</div>");
    expect(teamChunk(html, fx.root.id)).toContain("Owner</div>");
  });

  it("the Units lines come from the stored units_map JSON: mapped names, a raw unknown key, and the empty [] → None", async () => {
    const panel = await fetchUi(PROJECT_PATH, { headers: { cookie: await sessionHeader(fx.orgOwnerId) } });
    const html = await panel.text();
    expect(teamChunk(html, fx.units.id)).toContain("Units: Code, Wiki");
    expect(teamChunk(html, fx.rawUnits.id)).toContain("Units: repo.custom");
    expect(teamChunk(html, fx.emptyUnits.id)).toContain("Units: None");
  });
});

// --- the collaborator row render (the select + the display name) -------------------

describe("the collaborator row render", () => {
  it("each row's select reflects the stored mode (write selected for scm-collab, read for scm-read)", async () => {
    const panel = await fetchUi(PAINT_PATH, { headers: { cookie: await sessionHeader(fx.ownerId) } });
    const html = await panel.text();
    expect(html).toContain('<option value="write" selected="">');
    expect(html).toContain('<option value="read" selected="">');
    expect(html).not.toContain('<option value="admin" selected="">');
  });

  it("a full name renders upstream's DisplayNameWithFullName form `username (Full Name)`", async () => {
    await drizzle(env.DB).update(users).set({ fullName: "Scm Collab Full" }).where(eq(users.id, fx.collabId));
    const panel = await fetchUi(PAINT_PATH, { headers: { cookie: await sessionHeader(fx.ownerId) } });
    expect(await panel.text()).toContain('href="/scm-collab">scm-collab (Scm Collab Full)</a>');
  });
});

// --- the claim pin (.git trim + the deeper/junk tails) -----------------------------

describe("the claim pin (the .git-trimmed repo segment and the unclaimed tails)", () => {
  it("the .git trim claims into the collaboration family (parse level)", () => {
    expect(parseUiRoute("/scm-owner/scm-paint.git/settings/collaboration")).toEqual({
      family: "settings-collaboration",
      owner: "scm-owner",
      repo: "scm-paint",
    });
    expect(parseUiRoute("/scm-owner/scm-paint.git/settings/collaboration/team/delete")).toEqual({
      family: "settings-collab-team-delete",
      owner: "scm-owner",
      repo: "scm-paint",
    });
    expect(handlesUiRoute("/scm-owner/scm-paint.git/settings/collaboration")).toBe(true);
  });

  it("the .git-trimmed panel URL serves the same page (route level, owner session)", async () => {
    const res = await fetchUi("/scm-owner/scm-paint.git/settings/collaboration", {
      headers: { cookie: await sessionHeader(fx.ownerId) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('class="page-content repository settings collaboration"');
  });

  it("deeper and junk tails stay engine-owned (no claim)", () => {
    for (const tail of [
      "/scm-owner/scm-paint/settings/collaboration/access_mode/extra",
      "/scm-owner/scm-paint/settings/collaboration/team/extra",
      "/scm-owner/scm-paint/settings/collaboration/team/delete/extra",
      "/scm-owner/scm-paint/settings/collaborations",
    ]) {
      expect(parseUiRoute(tail), tail).toBeNull();
      expect(handlesUiRoute(tail), tail).toBe(false);
    }
  });
});
