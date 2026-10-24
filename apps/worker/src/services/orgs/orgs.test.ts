/**
 * Org service on real D1 (SPEC-0007 §5, service-layer half): create/list/get
 * roundtrip with the §2.2 self-list semantics, the §4.7 anonymous-repos
 * quirk, the §3.4 repo-create grant, the §4.3 last-owner guard, the §4.11
 * type-blind-then-check resolution, and rename storage behavior (§4.4 —
 * repos untouched, redirect seam).
 *
 * Schema: landed migrations (applyAuthD1Migrations) + the DDL-in-waiting
 * (applyOrgsDdl) until the drizzle migration lands.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { RepoService } from "../../repos/service";
import {
  LastOrgOwnerError,
  OrgMemberUserNotExistError,
  OrgNameCharsInvalidError,
  OrgNameCollisionError,
  OrgNamePatternNotAllowedError,
  OrgNameReservedError,
  OrgNameTooLongError,
  OrgNotExistError,
} from "./errors";
import { OrgService, type CreateOrgInput, type OrgRecord } from "./orgs";
import { applyOrgsDdl, resetOrgTables } from "./testing";

const service = (): OrgService => new OrgService(env.DB);
const repoService = (): RepoService => new RepoService(env.DB);

async function seedOrg(
  name: string,
  options: Partial<Omit<CreateOrgInput, "name" | "ownerId">> = {},
): Promise<OrgRecord> {
  const owner = await seedVerifiedUser({ username: `${name}-owner` });
  return service().createOrg({ name, ownerId: owner.id, ...options });
}

/** Seed a repo owned by an org through the landed repos service. */
async function seedOrgRepo(org: OrgRecord, slug: string, isPrivate = false): Promise<string> {
  const repo = await repoService().create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: slug,
    isPrivate,
  });
  return repo.id;
}

/** The storage-level row, for asserting what actually landed. */
const rawUserRow = (lower: string): Promise<Record<string, unknown> | null> =>
  env.DB
    .prepare("SELECT id, username, type, visibility, num_members, full_name FROM users WHERE username_lower = ?")
    .bind(lower)
    .first();

const rawMemberships = async (orgId: number): Promise<{ user_id: number; role: string; is_public: number }[]> =>
  (
    await env.DB
      .prepare("SELECT user_id, role, is_public FROM org_members WHERE org_id = ? ORDER BY user_id")
      .bind(orgId)
      .all<{ user_id: number; role: string; is_public: number }>()
  ).results;

beforeAll(async () => {
  await applyAuthD1Migrations();
  await applyOrgsDdl();
});

beforeEach(resetOrgTables);

describe("createOrg + resolution roundtrip (§2.1, §3.1)", () => {
  it("writes the org-as-user row and the owner membership in one batch", async () => {
    const owner = await seedVerifiedUser({ username: "Alice" });
    const org = await service().createOrg({
      name: "Acme",
      ownerId: owner.id,
      fullName: "Acme Corp",
      description: "rockets",
      location: "Perlan",
    });

    // Row shape (§5 lifecycle): type='org', num_members=1, creator owner.
    expect(org.username).toBe("Acme");
    expect(org.usernameLower).toBe("acme");
    expect(org.visibility).toBe("public");
    expect(org.numMembers).toBe(1);
    expect(await rawUserRow("acme")).toMatchObject({ type: "org", num_members: 1, full_name: "Acme Corp" });
    const memberships = await rawMemberships(org.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ user_id: owner.id, role: "owner", is_public: 0 });
  });

  it("resolves case-insensitively and reads plain users / unknown names as null (§4.11)", async () => {
    const org = await seedOrg("Acme");
    const alice = await seedVerifiedUser({ username: "Alice" });

    expect((await service().getOrgByUsername("ACME"))?.id).toBe(org.id);
    // Type-blind row exists, then the type check rejects it — the exact
    // SPEC-0003 owner-resolution mirror: 404-shaped miss, never user-shaped.
    expect(await rawUserRow("alice")).toMatchObject({ type: "user" });
    expect(await service().getOrgByUsername("alice")).toBeNull();
    expect(await service().getOrgByUsername("ALICE")).toBeNull();
    expect(await service().getOrgByUsername("nobody")).toBeNull();
    expect(await service().getOrgById(alice.id)).toBeNull();
  });

  it("arbitrates the shared namespace on UNIQUE(username_lower) — usernames block org slugs", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const err = await service().createOrg({ name: "Alice", ownerId: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgNameCollisionError);
    expect((err as OrgNameCollisionError).status).toBe(409);
    // Upstream ErrUserAlreadyExist message, case-folded name.
    expect((err as OrgNameCollisionError).message).toBe("user already exists [name: Alice]");

    await seedOrg("Acme");
    const second = await service().createOrg({ name: "ACME", ownerId: 1 }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(OrgNameCollisionError);
  });

  it("validates names with the ported IsUsableUsername rules (§4.1, §4.12)", async () => {
    const creator = (await seedVerifiedUser({ username: "Founder" })).id;
    // Upstream checks the validity pattern BEFORE the reserved list
    // (user.go:665–666), so a leading-dot name is a chars error even though
    // it is also reserved.
    const cases: [string, new (...args: never[]) => Error][] = [
      ["api", OrgNameReservedError],
      ["swagger.v1.json", OrgNameReservedError],
      ["ghost", OrgNameReservedError],
      ["invite.rss", OrgNamePatternNotAllowedError],
      ["key.gpg", OrgNamePatternNotAllowedError],
      [".well-known", OrgNameCharsInvalidError],
      ["a..b", OrgNameCharsInvalidError],
      ["-lead", OrgNameCharsInvalidError],
      ["trail.", OrgNameCharsInvalidError],
      ["has space", OrgNameCharsInvalidError],
    ];
    for (const [name, errorClass] of cases) {
      const err = await service().createOrg({ name, ownerId: creator }).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(errorClass);
      // The typed-error discriminators carry the class name.
      expect((err as Error).name, name).toBe(errorClass.name);
    }
    expect((await service().createOrg({ name: "ok.name-1", ownerId: creator })).username).toBe("ok.name-1");

    // The CreateOrgOption MaxSize(40) binding as a service sanity check.
    const long = "a".repeat(41);
    const err = await service().createOrg({ name: long, ownerId: creator }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgNameTooLongError);
  });

  it("creating on a name that is a live redirect consumes the redirect (§4.10)", async () => {
    const org = await seedOrg("OldOrg");
    await service().renameOrg(org.id, "NewOrg");
    expect(await service().lookupUserRedirect("oldorg")).toBe(org.id);

    const creator = (await seedVerifiedUser({ username: "Founder" })).id;
    const replacement = await service().createOrg({ name: "oldorg", ownerId: creator });
    expect(await service().lookupUserRedirect("oldorg")).toBeNull();
    expect(replacement.usernameLower).toBe("oldorg");
  });
});

describe("listUserOrgs (§2.2 row 1 self-list semantics)", () => {
  it("self-list skips the is_public filter and orders lower_name ASC", async () => {
    const member = await seedVerifiedUser({ username: "Carol" });
    const pub = await seedOrg("Zeta", { visibility: "public" });
    const lim = await seedOrg("Alpha", { visibility: "limited" });
    const pri = await seedOrg("Midas", { visibility: "private" });

    // Two non-public-flagged memberships on purpose (upstream default false).
    await service().addMember(pub.id, member.id, { isPublic: true });
    await service().addMember(lim.id, member.id, { isPublic: false });
    await service().addMember(pri.id, member.id, { isPublic: false });

    // Self (ceiling 'private' — the default): ALL memberships, is_public
    // ignored, ordered by lower_name (Alpha, Midas, Zeta).
    const self = await service().listUserOrgs(member.id);
    expect(self.total).toBe(3);
    expect(self.items.map((org) => org.usernameLower)).toEqual(["alpha", "midas", "zeta"]);
    expect(self.items.map((org) => org.visibility)).toEqual(["limited", "private", "public"]);
  });

  it("public-only / other-viewer ceilings degrade visibility AND membership flags", async () => {
    const member = await seedVerifiedUser({ username: "Carol" });
    const pub = await seedOrg("Pub", { visibility: "public" });
    const lim = await seedOrg("Lim", { visibility: "limited" });
    const pri = await seedOrg("Pri", { visibility: "private" });
    await service().addMember(pub.id, member.id, { isPublic: true });
    await service().addMember(lim.id, member.id, { isPublic: true });
    await service().addMember(pri.id, member.id, { isPublic: true });
    // A public org whose membership is NOT public-flagged (the
    // org_list.go:57–63 degrade drops it too).
    const secret = await seedOrg("Secret", { visibility: "public" });
    await service().addMember(secret.id, member.id, { isPublic: false });

    const pubOnly = await service().listUserOrgs(member.id, { maxVisibility: "public" });
    expect(pubOnly.items.map((org) => org.usernameLower)).toEqual(["pub"]);

    const limited = await service().listUserOrgs(member.id, { maxVisibility: "limited" });
    expect(limited.items.map((org) => org.usernameLower)).toEqual(["lim", "pub"]);

    const userships = await service().listUserOrgs(member.id);
    expect(userships.total).toBe(4);
  });

  it("paginates with SPEC-0004 §2.5 clamps (30 default / 50 max)", async () => {
    const member = await seedVerifiedUser({ username: "Carol" });
    for (let i = 0; i < 3; i++) {
      const org = await seedOrg(`org-${String(i).padStart(2, "0")}`);
      await service().addMember(org.id, member.id);
    }
    const page = await service().listUserOrgs(member.id, { page: 2, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect((await service().listUserOrgs(member.id, { pageSize: 100 })).items).toHaveLength(3);
  });
});

describe("listOrgRepos (§2.2 row 2, §4.7 anonymity quirk)", () => {
  it("lists public repos of a limited/private org ANONYMOUSLY — no owner-visibility gate", async () => {
    const org = await seedOrg("Quiet", { visibility: "public" });
    const publicRepo = await seedOrgRepo(org, "open");
    await seedOrgRepo(org, "hidden", true);

    // Flip the owner to limited, then private: the git gate would 401 and
    // GET /orgs/{org} would 404, but this listing keeps serving the public
    // repo to anonymous callers — the mirrored upstream quirk.
    await service().setOrgVisibility(org.id, "limited");
    const limited = await service().listOrgRepos(org.id, { id: null });
    expect(limited.total).toBe(1);
    expect(limited.items.map((repo) => repo.id)).toEqual([publicRepo]);
    expect((await service().getOrgByUsername("Quiet"))?.visibility).toBe("limited");

    await service().setOrgVisibility(org.id, "private");
    const priv = await service().listOrgRepos(org.id, { id: null });
    expect(priv.total).toBe(1);
    expect(priv.items.map((repo) => repo.id)).toEqual([publicRepo]);
  });

  it("signed doers: private rows only via tier-1 unit access (org owner) or admin", async () => {
    const org = await seedOrg("Staff", { visibility: "private" });
    await seedOrgRepo(org, "open");
    const privateId = await seedOrgRepo(org, "hidden", true);
    const owner = await seedVerifiedUser({ username: "Boss" });
    const plain = await seedVerifiedUser({ username: "Intern" });
    await service().addMember(org.id, owner.id, { role: "owner" });
    await service().addMember(org.id, plain.id, { role: "member" });

    // Plain member: no team at tier 1 ⇒ zero unit access ⇒ public rows only.
    const memberView = await service().listOrgRepos(org.id, { id: plain.id });
    expect(memberView.total).toBe(1);
    // Owner member: the Owners-team collapse sees private rows.
    const ownerView = await service().listOrgRepos(org.id, { id: owner.id });
    expect(ownerView.total).toBe(2);
    expect(ownerView.items.map((repo) => repo.id)).toContain(privateId);
    // Admin bypass.
    expect((await service().listOrgRepos(org.id, { id: null, isAdmin: true })).total).toBe(2);
    // Unknown org id lists empty (the route 404s at getOrgByUsername first).
    expect((await service().listOrgRepos(987654, { id: null })).total).toBe(0);
  });

  it("paginates by slug ASC with totals", async () => {
    const org = await seedOrg("Pager");
    for (const slug of ["c", "a", "b"]) await seedOrgRepo(org, slug);
    const page = await service().listOrgRepos(org.id, { id: null }, { page: 2, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.items.map((repo) => repo.slug)).toEqual(["c"]);
  });
});

describe("canCreateOrgRepo (§3.4 role='owner' equivalence)", () => {
  it("grants owners, refuses plain members and non-members", async () => {
    const org = await seedOrg("Builders");
    const creator = (await rawUserRow("builders-owner"))!.id as number;
    const plain = (await seedVerifiedUser({ username: "Intern" })).id;
    const outsider = (await seedVerifiedUser({ username: "Stranger" })).id;
    await service().addMember(org.id, plain, { role: "member" });

    expect(await service().canCreateOrgRepo(org.id, creator)).toBe(true);
    expect(await service().canCreateOrgRepo(org.id, plain)).toBe(false);
    expect(await service().canCreateOrgRepo(org.id, outsider)).toBe(false);
    // Site-admin bypass is caller-level (fork.go:97–108), not in the predicate.
  });
});

describe("membership guards (§4.3 last-owner, §4.5 states)", () => {
  it("refuses removing the only owner with the upstream 500-mapped error", async () => {
    const org = await seedOrg("Lone");
    const ownerId = (await rawUserRow("lone-owner"))!.id as number;

    const err = await service().removeMember(org.id, ownerId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LastOrgOwnerError);
    expect((err as LastOrgOwnerError).status).toBe(500);
    expect((err as LastOrgOwnerError).message).toBe(`user is the last member of owner team [uid: ${ownerId}]`);
    // Nothing moved.
    expect(await rawMemberships(org.id)).toHaveLength(1);
    expect((await rawUserRow("lone"))?.num_members).toBe(1);

    // Same guard on the demote path (§4.3: ANY change leaving zero owners).
    const demote = await service().setMemberRole(org.id, ownerId, "member").catch((e: unknown) => e);
    expect(demote).toBeInstanceOf(LastOrgOwnerError);
  });

  it("removes and demotes freely once a second owner exists; counter tracks", async () => {
    const org = await seedOrg("Duo");
    const first = (await rawUserRow("duo-owner"))!.id as number;
    const second = (await seedVerifiedUser({ username: "Second" })).id;
    await service().addMember(org.id, second, { role: "owner" });
    expect((await rawUserRow("duo"))?.num_members).toBe(2);

    expect(await service().removeMember(org.id, first)).toBe(true);
    expect((await rawUserRow("duo"))?.num_members).toBe(1);
    expect(await rawMemberships(org.id)).toEqual([{ user_id: second, role: "owner", is_public: 0 }]);

    // Demote the remaining owner after promoting a replacement.
    const third = (await seedVerifiedUser({ username: "Third" })).id;
    await service().addMember(org.id, third);
    expect(await service().setMemberRole(org.id, third, "owner")).toBe(true);
    expect(await service().setMemberRole(org.id, second, "member")).toBe(true);
    // rawMemberships orders by user_id: Second was seeded before Third.
    expect(await rawMemberships(org.id)).toEqual([
      { user_id: second, role: "member", is_public: 0 },
      { user_id: third, role: "owner", is_public: 0 },
    ]);
  });

  it("addMember is idempotent (upstream AddOrgUser silence) and validates targets", async () => {
    const org = await seedOrg("Members");
    const user = (await seedVerifiedUser({ username: "Newbie" })).id;

    expect(await service().addMember(org.id, user)).toBe(true);
    expect(await service().addMember(org.id, user)).toBe(false);
    expect((await rawUserRow("members"))?.num_members).toBe(2); // creator + one

    const missingUser = await service().addMember(org.id, 424242).catch((e: unknown) => e);
    expect(missingUser).toBeInstanceOf(OrgMemberUserNotExistError);
    const missingOrg = await service().addMember(424242, user).catch((e: unknown) => e);
    expect(missingOrg).toBeInstanceOf(OrgNotExistError);
    expect(await service().removeMember(org.id, 424242)).toBe(false); // non-member: silent no-op
  });
});

describe("renameOrg (§4.4 metadata-only + redirect seam)", () => {
  it("rewrites the namespace, leaves repos untouched, files the redirect", async () => {
    const org = await seedOrg("Acme");
    const repoId = await seedOrgRepo(org, "rocket");
    const before = await repoService().get(repoId);

    const renamed = await service().renameOrg(org.id, "AcmeLabs");

    // users row flipped; redirect old→id (the 307 owner-segment seam).
    expect(renamed.username).toBe("AcmeLabs");
    expect(renamed.usernameLower).toBe("acmelabs");
    expect(await service().lookupUserRedirect("acme")).toBe(org.id);
    expect(await service().lookupUserRedirect("acmelabs")).toBeNull();

    // The repo row keeps its identity and storage; only the denormalized
    // owner_namespace flips (upstream's owner_name rewrite) so /neworg/…
    // resolves. repo_redirects untouched (owner_id keyed).
    const after = await repoService().get(repoId);
    expect(after).toMatchObject({
      id: before?.id,
      storageKey: before?.storageKey,
      slug: before?.slug,
      visibility: before?.visibility,
      refsVersion: before?.refsVersion,
      ownerId: org.id,
      ownerNamespace: "acmelabs",
    });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM repo_redirects").first<{ n: number }>())?.n,
    ).toBe(0);
    // Re-resolution through the new namespace works; getOrgByUsername
    // follows the users row, not a cached name.
    expect((await service().getOrgByUsername("ACMELABS"))?.id).toBe(org.id);
    expect(await service().getOrgByUsername("acme")).toBeNull();
  });

  it("case-only renames flip display case and write NO redirect (user.go:48–59)", async () => {
    const org = await seedOrg("acme");
    const renamed = await service().renameOrg(org.id, "ACME");
    expect(renamed.username).toBe("ACME");
    expect(renamed.usernameLower).toBe("acme");
    expect(await service().lookupUserRedirect("acme")).toBeNull();
  });

  it("renaming onto a live redirect consumes it; collisions refuse", async () => {
    const first = await seedOrg("First");
    await service().renameOrg(first.id, "Moved");
    expect(await service().lookupUserRedirect("first")).toBe(first.id);

    const second = await seedOrg("Second");
    const renamed = await service().renameOrg(second.id, "First"); // shadowed name
    expect(renamed.usernameLower).toBe("first");
    expect(await service().lookupUserRedirect("first")).toBeNull(); // consumed
    expect(await service().lookupUserRedirect("second")).toBe(second.id);

    await seedVerifiedUser({ username: "Alice" });
    const clash = await service().renameOrg(second.id, "alice").catch((e: unknown) => e);
    expect(clash).toBeInstanceOf(OrgNameCollisionError);

    const same = await service().renameOrg(second.id, "First");
    expect(same.username).toBe("First"); // exact no-op returns the row
  });

  it("404-shapes unknown orgs and invalid names", async () => {
    const missing = await service().renameOrg(424242, "whatever").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OrgNotExistError);
    expect((missing as OrgNotExistError).message).toBe("org does not exist [id: 424242, name: ]");

    const org = await seedOrg("Valid");
    const bad = await service().renameOrg(org.id, "bad..name").catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(OrgNameCharsInvalidError);
  });
});

describe("setOrgVisibility (§4.8)", () => {
  it("flips the users-row column in place", async () => {
    const org = await seedOrg("Chameleon");
    await service().setOrgVisibility(org.id, "limited");
    expect((await service().getOrgByUsername("chameleon"))?.visibility).toBe("limited");
    await service().setOrgVisibility(org.id, "private");
    expect(await rawUserRow("chameleon")).toMatchObject({ visibility: "private" });

    const missing = await service().setOrgVisibility(424242, "public").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OrgNotExistError);
  });
});
