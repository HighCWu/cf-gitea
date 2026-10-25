/**
 * Route-level enforcement of the SPEC-0007 §3.5 WRITE/admin team grants —
 * the audit's flagged tail (d496ab8 landed the read side): a write/admin-
 * mode team member must WRITE and ADMINISTER through the API seams, not
 * just read. The repo-grant arms live in services/repo-access.ts riding the
 * ONE landed composition (`viewerTeamAccessMode` → `doerRepoAccessMode`,
 * mapped through `repositoryPermissions`' AccessMode→Permission block).
 *
 * Three surfaces, on REAL engine content (the org-owned private repo is
 * seeded through the landed git-http receive flow as the org owner — the
 * Owners-team bridge admits that push):
 *
 *  - GET /orgs/{org}/repos — the listing twin: the team member sees the
 *    granted private repo (upstream's listUserRepos keeps rows where
 *    `GetDoerRepoPermission(...).HasAnyUnitAccess()`, routers/api/v1/user/
 *    repo.go:41–45, whose team resolution is GetUserRepoTeams); the stranger
 *    and anonymous stay public-only.
 *  - PUT /repos/{owner}/{repo}/contents/{filepath} — the write seam
 *    (services/contents.applyFileChanges → canWriteRepository): the
 *    write-team member lands a commit (201); the read-team member gets
 *    upstream's 403 write message; the stranger the anti-enumeration 404.
 *  - PATCH /repos/{owner}/{repo} (repoEdit — the settings admin arm,
 *    `requireRepoAdmin`): the admin-team member edits (200); the write-team
 *    member gets upstream's exact reqAdmin 403 message (api.go:386).
 */

import { SELF, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { teamMembers, teamRepoAccess, teams, type TeamAccessMode } from "../db/schema";
import { OrgService, type OrgRecord } from "../services/orgs/orgs";
import { RepoService } from "../repos/service";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../ui/testing/seed-repo";

const ORIGIN = "https://example.com";
const T0 = 1_770_000_000;

const SEED_COMMITS: SeedCommit[] = [
  { message: "seed: readme", time: T0, files: [{ path: "README.md", content: "# team write suite\n" }] },
];

/** Plaintext tokens per role, minted in beforeAll. */
const tokens = new Map<string, string>();

/** Team with one member, covering the given repo ids. */
async function seedTeam(
  org: OrgRecord,
  name: string,
  authorize: TeamAccessMode,
  userId: number,
  repoIds: string[],
): Promise<void> {
  const inserted = await drizzle(env.DB)
    .insert(teams)
    .values({ orgId: org.id, lowerName: name, name, authorize, visibility: "private" })
    .returning({ id: teams.id })
    .all();
  const teamId = inserted[0]!.id;
  await drizzle(env.DB).insert(teamMembers).values({ orgId: org.id, teamId, userId });
  for (const repoId of repoIds) {
    await drizzle(env.DB).insert(teamRepoAccess).values({ orgId: org.id, teamId, repoId });
  }
}

/** Authenticated /api/v1 request through the REAL worker. */
const api = async (path: string, token: string, init: RequestInit = {}): Promise<Response> =>
  SELF.fetch(`${ORIGIN}/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
    },
  });

const token = (role: string): string => {
  const value = tokens.get(role);
  if (value === undefined) throw new Error(`token ${role} missing`);
  return value;
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "TwOwner" });
  const writeMate = await seedVerifiedUser({ username: "WriteMate" });
  const readMate = await seedVerifiedUser({ username: "ReadMate" });
  const adminMate = await seedVerifiedUser({ username: "AdminMate" });
  const stranger = await seedVerifiedUser({ username: "TwStranger" });

  const org = await new OrgService(env.DB).createOrg({ name: "tworg", ownerId: owner.id });
  const repo = await new RepoService(env.DB).create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: "vault",
    isPrivate: true,
    status: "ready",
  });

  // REAL engine content: the org owner pushes the seed pack through the
  // landed git-http receive flow (the Owners-team bridge admits the push).
  const ownerToken = (await mintFor(owner.id, "tw-owner-push", "all")).plaintext;
  const { tips, pack } = await buildHistoryPack(SEED_COMMITS);
  const pushed = await SELF.fetch(`${ORIGIN}/${org.usernameLower}/${repo.slug}.git/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: basicTokenHeader(ownerToken),
      "content-type": "application/x-git-receive-pack-request",
    },
    body: buildReceivePackBody([{ ref: "refs/heads/main", oid: tips[tips.length - 1] as string }], pack),
  });
  if (pushed.status !== 200) throw new Error(`seed push failed: ${pushed.status}`);

  await seedTeam(org, "writers", "write", writeMate.id, [repo.id]);
  await seedTeam(org, "readers", "read", readMate.id, [repo.id]);
  await seedTeam(org, "admins", "admin", adminMate.id, [repo.id]);

  for (const [role, user] of [
    ["owner", owner],
    ["write", writeMate],
    ["read", readMate],
    ["admin", adminMate],
    ["stranger", stranger],
  ] as const) {
    tokens.set(role, (await mintFor(user.id, `tw-${role}`, "all")).plaintext);
  }
});

describe("GET /orgs/{org}/repos — the listing twin of the team grant", () => {
  it("the team member sees the granted private repo; the stranger and anonymous stay public-only", async () => {
    const member = await api("/orgs/tworg/repos", token("write"));
    expect(member.status).toBe(200);
    const list = await member.json<Array<{ full_name: string; private: boolean }>>();
    expect(list.map((repo) => repo.full_name)).toEqual(["tworg/vault"]);
    expect(list[0]?.private).toBe(true);

    for (const res of [
      await api("/orgs/tworg/repos", token("stranger")),
      await SELF.fetch(`${ORIGIN}/api/v1/orgs/tworg/repos`),
    ]) {
      expect(res.status).toBe(200);
      expect(await res.json<unknown[]>()).toEqual([]);
    }
  });
});

describe("PUT /repos/{owner}/{repo}/contents/{filepath} — the write seam (applyFileChanges)", () => {
  it("the write-team member lands a commit (201) and the owner reads it back", async () => {
    const res = await api("/repos/tworg/vault/contents/notes.txt", token("write"), {
      method: "PUT",
      body: JSON.stringify({ content: btoa("team-written\n"), message: "team write" }),
    });
    expect(res.status).toBe(201);

    const read = await api("/repos/tworg/vault/contents/notes.txt", token("owner"));
    expect(read.status).toBe(200);
    const body = await read.json<{ encoding: string; content: string }>();
    expect(body.encoding).toBe("base64");
    expect(atob(body.content)).toBe("team-written\n");
  });

  it("the read-team member gets upstream's 403 write message; the stranger the 404", async () => {
    const denied = await api("/repos/tworg/vault/contents/notes.txt", token("read"), {
      method: "PUT",
      body: JSON.stringify({ content: btoa("nope\n"), message: "read-only" }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json<{ message: string }>()).toMatchObject({
      message: "user should have a permission to write to the target branch",
    });

    // Anti-enumeration: an invisible repo stays missing-shaped on a write.
    const stranger = await api("/repos/tworg/vault/contents/notes.txt", token("stranger"), {
      method: "PUT",
      body: JSON.stringify({ content: btoa("nope\n"), message: "hidden" }),
    });
    expect(stranger.status).toBe(404);
  });
});

describe("PATCH /repos/{owner}/{repo} (repoEdit) — the settings admin arm", () => {
  it("the admin-team member edits the repo and renders the admin permissions block", async () => {
    const res = await api("/repos/tworg/vault", token("admin"), {
      method: "PATCH",
      body: JSON.stringify({ description: "edited by the admin team" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json<{ description: string }>()).toMatchObject({
      description: "edited by the admin team",
    });

    // The rendered permissions block (repoGet threads the same grant).
    const probe = await api("/repos/tworg/vault", token("admin"));
    expect(probe.status).toBe(200);
    expect(await probe.json<{ permissions: unknown }>()).toMatchObject({
      permissions: { admin: true, push: true, pull: true },
    });
  });

  it("the write-team member is not admin: upstream's exact reqAdmin 403 message", async () => {
    const res = await api("/repos/tworg/vault", token("write"), {
      method: "PATCH",
      body: JSON.stringify({ description: "write is not admin" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json<{ message: string }>()).toMatchObject({
      message: "user should be an owner or a collaborator with admin write of a repository",
    });
  });
});
