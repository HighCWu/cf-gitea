/**
 * The census B-77 TEAM-INVITE lane's route battery (pages/team-invite.tsx +
 * the ui/index.ts invite regions over the landed TeamsService invite arms):
 * the minted-session route arms driven through `uiRouter.fetch()` on the
 * real production path (the org-teams.matrix pattern), one fresh org world
 * per test behind per-test table wipes.
 *
 * The arms this file owns (org-teams.matrix.test.tsx and the wave-12 suites
 * carry none of them):
 *
 *   - the /org/invite/{token} claim pins: the 4-segment family (token
 *     decode, junk-encode → null), the trailing-slash fold, and the STATIC
 *     SHADOW — chi descends the literal `invite` level before the `/{org}`
 *     param node, so /org/invite/members (token="members") is the INVITE
 *     family, never the org-"invite" members page, and any deeper
 *     /org/invite/** tail (raw length > 4) is null → the engine's 404;
 *   - the redeem GET (org.TeamInvite, teams.go:583-606): the anonymous 303
 *     (the reqSignIn group), the unknown token's 404 shell, the rendered
 *     card's byte shapes (title, the invite.title sentence, the inviter
 *     line, the description, the self-POSTing Join form — accept-ONLY, no
 *     decline arm exists upstream), and the dangling-inviter 500 (the
 *     getTeamInviteFromContext ServerError — never a 404 leak);
 *   - the redeem POST (org.TeamInvitePost, teams.go:608-627): the gate
 *     ladder (anonymous 303 → unknown token 404 → cross-origin 403 — the
 *     guard runs FIRST), the happy path (the bearer JOINS regardless of
 *     the invited email — the token IS the authority — org membership
 *     created as the side effect, invite row removed, 303 onto the NAME
 *     form /org/{org}/teams/{lowername}), and the chi 405 on the unclaimed
 *     methods;
 *   - the action add arm's email-invite fork (teams.go:171-194): mail OFF
 *     + email uname = the user_not_exist arm (no row — the pre-B77
 *     posture), mail ON + email = the team_invites row + the outbox row
 *     (the login/sign_up redirect_to fork over the account-exists probe,
 *     the dedupe identity), the duplicate and already-member refusals
 *     (still a 303, still messageless — one row / no row respectively),
 *     the not-an-email uname (no row), and the armed-but-unparseable-FROM
 *     skip (the notify prelude's semantics: the row stands, no mail);
 *   - the action remove_invite arm (teams.go:204-222): the owner gate's
 *     404, the iid==0 redirect, the both-key delete (a foreign team's iid
 *     deletes nothing), and the owner's happy removal;
 *   - the members page's Pending Invitations region (members.tmpl:51-70):
 *     owner-gated render (the email + the remove_invite form), absent for
 *     a plain member and when no invites exist.
 *
 * The fixture org is `inviteorg` (nadia owner, milo plain member, vera the
 * outsider bearer, adminmx the site admin), seeded through the LANDED
 * OrgService/TeamsService arms; ids captured at seed time.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { TeamsService, type TeamInviteRecord, type TeamRecord } from "../../api/routes/org-teams";
import { emailOutbox, teamInvites, teamMembers, orgMembers, users } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The MAIL_* override slice (the admin-config battery's widened-view write:
 *  the generated Env pins the deployed var literals, so the overrides assign
 *  onto a FRESH env copy through the plain-string view — never mutating the
 *  shared env). */
type MailOverrides = { MAIL_ENABLED?: string; MAIL_FROM?: string };

function routeEnvWithMail(overrides: MailOverrides = {}): RouteEnv {
  const envCopy: RouteEnv = { ...routeEnv };
  const writable = envCopy as MailOverrides;
  writable.MAIL_ENABLED = "true";
  writable.MAIL_FROM = "Gitea <noreply@test.local>";
  for (const key of Object.keys(overrides) as Array<keyof MailOverrides>) {
    const value = overrides[key];
    if (value !== undefined) writable[key] = value;
  }
  return envCopy;
}

/** The mail-ARMED twin (the add arm's `setting.MailService != nil` polarity). */
const armedEnv: RouteEnv = routeEnvWithMail();

/** The tables the fixtures and the arms touch (children first; sessions
 *  explicit — minted per request; email_outbox explicit — the funnel's rows
 *  are the mail arm's evidence). */
const FIXTURE_TABLES = [
  "email_outbox",
  "team_invites",
  "team_repo_access",
  "team_members",
  "teams",
  "repositories",
  "org_members",
  "user_redirects",
  "sessions",
  "users",
];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

interface InviteWorld {
  org: OrgRecord;
  ownerId: number; // nadia — the org owner (inviter)
  memberId: number; // milo — plain member, NOT owner
  bearerId: number; // vera — signed-in outsider (the redeem bearer)
  patId: number; // pat — has account+email, NOT an org member (the login-fork probe)
  team: TeamRecord;
}

async function seedInviteWorld(): Promise<InviteWorld> {
  const owner = await seedVerifiedUser({ username: "nadia" });
  const member = await seedVerifiedUser({ username: "milo" });
  const bearer = await seedVerifiedUser({ username: "vera" });
  const pat = await seedVerifiedUser({ username: "pat" });
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "inviteorg", ownerId: owner.id, visibility: "public", now: new Date() });
  await orgs.addMember(org.id, member.id, { now: new Date() });
  // The email carriers: the owner's address is the already-member probe; pat's
  // is the login-fork probe (an account exists, outside the org).
  await env.DB.prepare(`UPDATE users SET email = 'nadia@example.com' WHERE id = ${owner.id}`).run();
  await env.DB.prepare(`UPDATE users SET email = 'pat@example.com' WHERE id = ${pat.id}`).run();
  const service = new TeamsService(env.DB);
  const team = await service.createTeam(org, { name: "Alpha Crew", permission: "write" });
  return { org, ownerId: owner.id, memberId: member.id, bearerId: bearer.id, patId: pat.id, team };
}

/** Seeds an invite row straight through the landed arm (the dedupe identity
 *  pins ride createTeamInvite, so the fixture IS the production write). */
async function seedInvite(world: InviteWorld, email: string, inviterId = world.ownerId): Promise<TeamInviteRecord> {
  return new TeamsService(env.DB).createTeamInvite({ id: inviterId }, world.team, email);
}

// --- the mounted-route harness -----------------------------------------------

async function fetchUiOn(e: RouteEnv, path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), e, context);
  await waitOnExecutionContext(context);
  return response;
}

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return fetchUiOn(routeEnv, path, init);
}

async function sessionCookie(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

async function getRoute(path: string, userId: number | null): Promise<Response> {
  return fetchUi(path, { headers: userId === null ? {} : { cookie: await sessionCookie(userId) } });
}

async function postArm(
  path: string,
  userId: number | null,
  fields: Record<string, string>,
  e: RouteEnv = routeEnv,
  origin: string | null = ORIGIN,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  if (userId !== null) headers.cookie = await sessionCookie(userId);
  return fetchUiOn(e, path, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
}

async function allInvites(): Promise<TeamInviteRecord[]> {
  return drizzle(env.DB).select().from(teamInvites).all();
}

async function allOutbox(): Promise<Array<typeof emailOutbox.$inferSelect>> {
  return drizzle(env.DB).select().from(emailOutbox).all();
}

// --- the claim pins ------------------------------------------------------------

describe("/org/invite/{token} claim pins (the B-77 family)", () => {
  it("claims exactly the 4-segment shape with the decoded token", () => {
    expect(parseUiRoute("/org/invite/tok-abc123")).toEqual({ family: "org-team-invite", token: "tok-abc123" });
    expect(parseUiRoute("/org/invite/tok-abc123/")).toEqual({ family: "org-team-invite", token: "tok-abc123" }); // the trailing-slash fold
    expect(handlesUiRoute("/org/invite/tok-abc123")).toBe(true);
  });

  it("junk-encodes stay unclaimed", () => {
    expect(parseUiRoute("/org/invite/%zz")).toBeNull();
  });

  it("the static shadow: /org/invite/{any} never resolves as the org 'invite'", () => {
    // chi descends the literal `invite` level first: these are TOKEN carriers,
    // never the org-"invite" members/teams pages (upstream's static-first
    // descent over the {org} param node).
    expect(parseUiRoute("/org/invite/members")).toEqual({ family: "org-team-invite", token: "members" });
    expect(parseUiRoute("/org/invite/teams")).toEqual({ family: "org-team-invite", token: "teams" });
    // A deeper tail has no route inside the {token} group (m.Get("")/m.Post("")
    // only) — null → the engine's 404, upstream's shape.
    expect(parseUiRoute("/org/invite/teams/7")).toBeNull();
    expect(parseUiRoute("/org/invite/members/action/leave")).toBeNull();
  });
});

// --- the redeem GET ------------------------------------------------------------

describe("GET /org/invite/{token} (org.TeamInvite, teams.go:583-606)", () => {
  it("303s an anonymous bearer onto login (the reqSignIn group)", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    const res = await getRoute(`/org/invite/${invite.token}`, null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("404-shells an unknown token", async () => {
    const world = await seedInviteWorld();
    const res = await getRoute("/org/invite/no-such-token", world.ownerId);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
  });

  it("renders the accept-only card (title, sentence, inviter, description, self-POST Join)", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    const res = await getRoute(`/org/invite/${invite.token}`, world.bearerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The page title (org.teams.invite_team_member over the team's name) ...
    expect(html).toContain(`Invite to ${world.team.name}`);
    // ... the org.teams.invite.title sentence (the <strong> pair) ...
    expect(html).toContain("You have been invited to join team <strong>");
    expect(html).toContain("</strong> in organization <strong>");
    // ... the inviter line + description ...
    expect(html).toContain("Invited by nadia");
    expect(html).toContain("Please click the button below to join the team.");
    // ... the single self-POSTing form (action="" — the browser resolves the
    // same path) with the Join button; NO decline control exists (the
    // accept-only derivation: removal is the org-side remove_invite).
    expect(html).toContain(`action=""`);
    expect(html).toContain('method="post"');
    expect(html).toContain(">Join</button>");
    expect(html).not.toContain("Decline");
    // The invited email renders nowhere on the page (invite.tmpl shows only
    // the team/org/inviter — the email lives in the mail's intended-for note).
    expect(html).not.toContain("newmail@example.com");
  });

  it("answers a dangling inviter with the 500 (ServerError — never a 404 leak)", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    await env.DB.prepare(`DELETE FROM users WHERE id = ${world.ownerId}`).run();
    const res = await getRoute(`/org/invite/${invite.token}`, world.bearerId);
    expect(res.status).toBe(500);
  });
});

// --- the redeem POST -----------------------------------------------------------

describe("POST /org/invite/{token} (org.TeamInvitePost, teams.go:608-627)", () => {
  it("rides the gate ladder: anonymous 303, unknown token 404, cross-origin 403 first", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    const anon = await postArm(`/org/invite/${invite.token}`, null, {});
    expect(anon.status).toBe(303);
    const unknown = await postArm("/org/invite/no-such-token", world.bearerId, {});
    expect(unknown.status).toBe(404);
    const crossOrigin = await postArm(`/org/invite/${invite.token}`, world.bearerId, {}, routeEnv, "https://evil.example");
    expect(crossOrigin.status).toBe(403);
    expect(await allInvites()).toHaveLength(1); // nothing consumed
  });

  it("joins the bearer (membership + org side effect), removes the invite, 303s the NAME form", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    const res = await postArm(`/org/invite/${invite.token}`, world.bearerId, {});
    expect(res.status).toBe(303);
    // teams.go:625 — OrganisationLink + PathEscape(LowerName): the NAME form.
    expect(res.headers.get("location")).toBe(`/org/${world.org.username}/teams/${world.team.lowerName}`);
    // The team row exists for the bearer, and AddTeamMember's org-membership
    // side effect landed (the bearer was an outsider).
    const teamRow = await drizzle(env.DB)
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, world.team.id))
      .all();
    expect(teamRow.map((row) => row.userId)).toContain(world.bearerId);
    const orgRow = await drizzle(env.DB).select().from(orgMembers).where(eq(orgMembers.orgId, world.org.id)).all();
    expect(orgRow.map((row) => row.userId)).toContain(world.bearerId);
    // The invite row is GONE (the redeem removes it).
    expect(await allInvites()).toHaveLength(0);
  });

  it("any signed-in bearer joins — the token is the authority, not the invited email", async () => {
    // upstream's TeamInvitePost never compares the doer's email with
    // invite.Email (teams.go:609-617); the mail's intended-for note is the
    // only soft guard. A SECOND bearer consuming pat's invite is the pin.
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "pat@example.com"); // addressed to pat
    const res = await postArm(`/org/invite/${invite.token}`, world.memberId, {}); // milo redeems
    expect(res.status).toBe(303);
    expect(await allInvites()).toHaveLength(0);
  });

  it("answers the unclaimed methods with chi's 405", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    const res = await fetchUi(`/org/invite/${invite.token}`, {
      method: "PUT",
      headers: { cookie: await sessionCookie(world.ownerId), origin: ORIGIN },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });
});

// --- the add arm's email-invite fork ---------------------------------------------

describe("the action add arm's email-invite fork (teams.go:171-194)", () => {
  const addPath = (world: InviteWorld): string => `/org/${world.org.username}/teams/${world.team.id}/action/add`;

  it("mail OFF + an email uname: the user_not_exist arm — no invite row (the pre-B77 posture)", async () => {
    const world = await seedInviteWorld();
    const res = await postArm(addPath(world), world.ownerId, { uname: "newmail@example.com" });
    expect(res.status).toBe(303);
    expect(await allInvites()).toHaveLength(0);
    expect(await allOutbox()).toHaveLength(0);
  });

  it("mail ON + an email uname: the tokenized row + the outbox row (the sign_up fork — no account)", async () => {
    const world = await seedInviteWorld();
    const res = await postArm(addPath(world), world.ownerId, { uname: "NewMail@Example.com" }, armedEnv);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/org/${world.org.username}/teams/${world.team.id}`);
    const invites = await allInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0]!.email).toBe("newmail@example.com"); // the add arm lowers (teams.go:168)
    expect(invites[0]!.token).toMatch(/^[a-zA-Z0-9]{25}$/); // CryptoRandomString(25)
    expect(invites[0]!.inviterId).toBe(world.ownerId);
    expect(invites[0]!.teamId).toBe(world.team.id);
    expect(invites[0]!.orgId).toBe(world.org.id);
    const outbox = await allOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.toAddr).toBe("newmail@example.com");
    expect(outbox[0]!.dedupeKey).toBe(`team-invite:${invites[0]!.id}`);
    expect(outbox[0]!.subject).toBe("nadia has invited you to join the inviteorg organization");
    // No account carries the email → the sign_up fork (mail_team_invite.go:45-49).
    expect(outbox[0]!.bodyHtml).toContain("/user/sign_up?redirect_to=");
    expect(outbox[0]!.bodyHtml).toContain(encodeURIComponent(`/org/invite/${invites[0]!.token}`));
  });

  it("mail ON + an email an ACCOUNT already carries: the login fork", async () => {
    const world = await seedInviteWorld();
    await postArm(addPath(world), world.ownerId, { uname: "pat@example.com" }, armedEnv);
    const outbox = await allOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.bodyHtml).toContain("/user/login?redirect_to=");
    expect(outbox[0]!.bodyHtml).not.toContain("/user/sign_up");
  });

  it("the duplicate refusal: still one row, still the messageless 303 (no second mail)", async () => {
    const world = await seedInviteWorld();
    await seedInvite(world, "newmail@example.com");
    const res = await postArm(addPath(world), world.ownerId, { uname: "newmail@example.com" }, armedEnv);
    expect(res.status).toBe(303); // form.duplicate_invite_to_team — messageless here
    expect(await allInvites()).toHaveLength(1);
    expect(await allOutbox()).toHaveLength(0);
  });

  it("the already-member-by-email refusal: no row (a TEAM member's address — the probe is team-scoped)", async () => {
    const world = await seedInviteWorld();
    // The probe joins team_user on (org_id, team_id, email) — an org owner
    // NOT on the team invites fine upstream, so the refusal needs a real team
    // member's address (milo joins, milo@example.com is stamped).
    await new TeamsService(env.DB).addTeamMember(world.team, world.memberId);
    await env.DB.prepare(`UPDATE users SET email = 'milo@example.com' WHERE id = ${world.memberId}`).run();
    const res = await postArm(addPath(world), world.ownerId, { uname: "milo@example.com" }, armedEnv);
    expect(res.status).toBe(303); // org.teams.add_duplicate_users — messageless
    expect(await allInvites()).toHaveLength(0);
    expect(await allOutbox()).toHaveLength(0);
  });

  it("mail ON + a NOT-email uname: the user_not_exist arm — no row", async () => {
    const world = await seedInviteWorld();
    const res = await postArm(addPath(world), world.ownerId, { uname: "not-an-email" }, armedEnv);
    expect(res.status).toBe(303);
    expect(await allInvites()).toHaveLength(0);
    expect(await allOutbox()).toHaveLength(0);
  });

  it("armed but unparseable MAIL_FROM: the notify prelude's skip — the row stands, no mail", async () => {
    const world = await seedInviteWorld();
    const broken = routeEnvWithMail({ MAIL_FROM: "" });
    const res = await postArm(addPath(world), world.ownerId, { uname: "newmail@example.com" }, broken);
    expect(res.status).toBe(303);
    expect(await allInvites()).toHaveLength(1);
    expect(await allOutbox()).toHaveLength(0);
  });

  it("a ProhibitLogin account at the invited email is the HARD error arm (the ServerError)", async () => {
    // mail_team_invite.go:37-39: the compose throws "login is prohibited for
    // the invited user" — not one of the flash-mapped refusals, so the add
    // arm rethrows and the handler 500s (the invite ROW stands, exactly
    // services/org/team_invite.go's insert-then-mail order).
    const world = await seedInviteWorld();
    await seedVerifiedUser({ username: "frozen", status: "prohibited" });
    const frozenId = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "frozen")).get())!.id;
    await env.DB.prepare(`UPDATE users SET email = 'frozen@example.com' WHERE id = ${frozenId}`).run();
    const res = await postArm(addPath(world), world.ownerId, { uname: "frozen@example.com" }, armedEnv);
    expect(res.status).toBe(500);
    expect(await allInvites()).toHaveLength(1); // the insert landed; the mail threw
    expect(await allOutbox()).toHaveLength(0);
  });

  it("the mail bytes carry the corpus shape: the subject pair and the DotEscaped text_1 names", async () => {
    const world = await seedInviteWorld();
    await postArm(addPath(world), world.ownerId, { uname: "newmail@example.com" }, armedEnv);
    const outbox = (await allOutbox())[0]!;
    // mail.team_invite.subject — NO DotEscape (mail_team_invite.go:42's raw
    // DisplayName interpolation).
    expect(outbox.subject).toBe("nadia has invited you to join the inviteorg organization");
    // The BODY's text_1 DotEscapes the three names (the template's
    // (DotEscape ...) pipeline — the zero-width non-joiner pair around each
    // dot of the display names; single-word names carry no dots, so pin the
    // sentence structure + the intended-for note instead).
    expect(outbox.bodyHtml).toContain("has invited you to join team Alpha Crew in organization inviteorg.</p>");
    expect(outbox.bodyHtml).toContain("Note: This invitation was intended for newmail@example.com.");
    expect(outbox.bodyHtml).toContain("Please click the following link to join the team:");
    expect(outbox.info).toBe(outbox.subject); // msg.Info = subject (mail_team_invite.go:63)
  });

  it("a non-owner's add 404-shells before any fork (teams.go:163-166)", async () => {
    const world = await seedInviteWorld();
    const res = await postArm(addPath(world), world.memberId, { uname: "newmail@example.com" }, armedEnv);
    expect(res.status).toBe(404);
    expect(await allInvites()).toHaveLength(0);
  });
});

// --- the remove_invite arm -------------------------------------------------------

describe("the action remove_invite arm (teams.go:204-222)", () => {
  const removePath = (world: InviteWorld): string => `/org/${world.org.username}/teams/${world.team.id}/action/remove_invite`;

  it("removes by (iid, teamId) and redirects onto the team slice", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    const res = await postArm(removePath(world), world.ownerId, { iid: String(invite.id) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/org/${world.org.username}/teams/${world.team.id}`);
    expect(await allInvites()).toHaveLength(0);
  });

  it("iid==0 redirects bare (teams.go:209-213)", async () => {
    const world = await seedInviteWorld();
    const res = await postArm(removePath(world), world.ownerId, {});
    expect(res.status).toBe(303);
    expect(await allInvites()).toHaveLength(0);
  });

  it("a foreign team's iid deletes nothing (the BOTH-key WHERE shape)", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    const res = await postArm(removePath(world), world.ownerId, { iid: String(invite.id + 10_000) });
    expect(res.status).toBe(303);
    expect(await allInvites()).toHaveLength(1);
  });

  it("a non-owner 404-shells (teams.go:204-207)", async () => {
    const world = await seedInviteWorld();
    const invite = await seedInvite(world, "newmail@example.com");
    const res = await postArm(removePath(world), world.memberId, { iid: String(invite.id) });
    expect(res.status).toBe(404);
    expect(await allInvites()).toHaveLength(1);
  });
});

// --- the members page's Pending Invitations region ------------------------------

describe("the team detail page's Pending Invitations region (members.tmpl:51-70)", () => {
  const detailPath = (world: InviteWorld): string => `/org/${world.org.username}/teams/${world.team.id}`;

  it("renders the owner-gated list (the email + the remove_invite form)", async () => {
    const world = await seedInviteWorld();
    await seedInvite(world, "newmail@example.com");
    const res = await getRoute(detailPath(world), world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pending Invitations");
    expect(html).toContain("newmail@example.com");
    expect(html).toContain(`action="${detailPath(world)}/action/remove_invite"`);
    expect(html).toContain(`name="iid"`);
  });

  it("a plain member 404-shells the whole detail page (the prologue's ownership gate)", async () => {
    const world = await seedInviteWorld();
    await seedInvite(world, "newmail@example.com");
    const memberView = await getRoute(detailPath(world), world.memberId);
    expect(memberView.status).toBe(404);
  });

  it("no invites — the section renders nothing (the members.tmpl:51 conjunction)", async () => {
    const world = await seedInviteWorld();
    const empty = await getRoute(detailPath(world), world.ownerId);
    expect(empty.status).toBe(200);
    expect(await empty.text()).not.toContain("Pending Invitations");
  });
});
