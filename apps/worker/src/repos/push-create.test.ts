/**
 * Push-create — SPEC-0003 §2.4 rows 15-20 + §2.5.2, table-driven over the
 * gitHttpGate's unknown-repository surface (real D1 + real engine DOs via
 * SELF.fetch; migrations applied from src/db/migrations).
 *
 * Row map (cf-gitea divergences documented in SPEC §2.4):
 *   15 anonymous            → 401 + Basic challenge (probe and POST)
 *   16 other user namespace → 404 at POST (probe still gets the dummy advert,
 *                             upstream githttp.go:229-233)
 *   17 own namespace        → probe: 200 dummy advertisement; POST: create
 *                             (status='creating' → settle) then receive
 *   18 push-create disabled → no live branch: cf-gitea defaults user
 *                             push-create ON (§2.4 divergence)
 *   19 org grant            → org-namespace create for holders of the org
 *                             repo-create grant (OrgService.canCreateOrgRepo:
 *                             role='owner' membership or a can_create_org_repo
 *                             team); site admin into an existing user's
 *                             namespace is the upstream PushCreateRepo admin
 *                             branch
 *   20 org without grant    → 404 (upstream maps EVERY PushCreateRepo error
 *                             to the bare 404, githttp.go:235-240)
 */

import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { settleCreatingRepo } from "../git-http/gate";
import { TeamsService } from "../api/routes/org-teams";
import { OrgService } from "../services/orgs/orgs";
import { repositories, repoCounters } from "../db/schema";
import { RepoService } from "./service";
import { buildPack, buildReceivePackBody } from "./testing/git-pack";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

/** Reset lifecycle state; the migration-seeded 'assets' reservation user
 *  stays (production shape: the reserved row is never deletable via API). */
beforeEach(async () => {
  for (const table of ["personal_access_tokens", "repo_units", "repo_transfer", "repo_redirects", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

const RECEIVE_CT = "application/x-git-receive-pack-request";

interface PushCreateCase {
  label: string;
  /** Repo URL fragment after the host, without .git. */
  path: string;
  /** "probe" = GET info/refs?service=git-receive-pack; "post" = receive RPC. */
  kind: "probe" | "post";
  /** POST carries a real one-commit pack instead of the empty "0000" body
   *  (rows whose created repo must SURVIVE the settle: a command-less
   *  receive lands no ref, so §2.5.2 undoes the create). */
  withPack?: boolean;
  auth?: (t: { alice: string; bob: string; admin: string; read: string; prohibited: string }) => string;
  expectStatus: number;
  expectChallenge?: boolean;
  expectDummyAdvert?: boolean;
  expectBody?: string;
  /** D1 row that must exist after the request (owner/slug). */
  expectRow?: { owner: string; slug: string };
}

describe("push-create ACL (SPEC-0003 §2.4 rows 15-20)", () => {
  async function seedTokens() {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });
    const carol = await seedVerifiedUser({ username: "Carol", status: "prohibited" });
    const mint = async (user: { id: number }, name: string, scopes: string) =>
      (await mintFor(user.id, name, scopes)).plaintext;
    return {
      alice: await mint(alice, "alice-write", "write:repository"),
      bob: await mint(bob, "bob-write", "write:repository"),
      admin: await mint(admin, "admin-write", "write:repository"),
      read: await mint(alice, "alice-read", "read:repository"),
      prohibited: await mint(carol, "carol-write", "write:repository"),
    };
  }

  const cases: PushCreateCase[] = [
    // Row 15: anonymous never reaches push-create logic — 401 + challenge.
    {
      label: "row 15: anonymous probe challenges with 401 Basic",
      path: "alice/anon-probe",
      kind: "probe",
      expectStatus: 401,
      expectChallenge: true,
    },
    {
      label: "row 15: anonymous POST challenges with 401 Basic",
      path: "alice/anon-post",
      kind: "post",
      expectStatus: 401,
      expectChallenge: true,
    },
    // Row 17 probe: dummy empty advertisement for a push-create path that is
    // plausibly available (authenticated, upstream ordering quirk §2.4).
    {
      label: "row 17: authenticated own-namespace probe gets the dummy advertisement",
      path: "alice/fresh",
      kind: "probe",
      auth: (t) => basicTokenHeader(t.alice),
      expectStatus: 200,
      expectDummyAdvert: true,
    },
    // Upstream :229-233: the probe serves the dummy advert for ANY namespace
    // (the enable flag is global); the real permission check is POST-time.
    {
      label: "row 16 probe: another user's namespace still gets the dummy advert (POST decides)",
      path: "bob/from-alice",
      kind: "probe",
      auth: (t) => basicTokenHeader(t.alice),
      expectStatus: 200,
      expectDummyAdvert: true,
    },
    // Row 16: POST into a namespace that is not the caller's → 404.
    {
      label: "row 16: POST into another user's namespace → 404 Repository not found",
      path: "bob/from-alice-post",
      kind: "post",
      auth: (t) => basicTokenHeader(t.alice),
      expectStatus: 404,
      expectBody: "Repository not found",
    },
    // Row 20 (404 branch): a nonexistent org namespace cannot be push-created.
    {
      label: "row 20: POST into a nonexistent org namespace → 404",
      path: "ghostorg/repo",
      kind: "post",
      auth: (t) => basicTokenHeader(t.alice),
      expectStatus: 404,
      expectBody: "Repository not found",
    },
    // Row 7 runs upstream of push-create: a verified token still needs the
    // write scope.
    {
      label: "row 7 first: read-scope token POST → plain 403",
      path: "alice/no-scope",
      kind: "post",
      auth: (t) => basicTokenHeader(t.read),
      expectStatus: 403,
      expectBody: "Forbidden\n",
    },
    // Row 11: prohibited doers never push-create.
    {
      label: "row 11: prohibited account POST → 403 account disabled",
      path: "carol/nope",
      kind: "post",
      auth: (t) => basicTokenHeader(t.prohibited),
      expectStatus: 403,
      expectBody: "Your account is disabled.",
    },
    // Row 19 (admin branch): site admins may push-create into an existing
    // user's namespace (upstream PushCreateRepo skips the ownership check for
    // IsAdmin). Carries a real pack so the created repo survives §2.5.2's
    // settle (a command-less receive lands no ref → the row is undone).
    {
      label: "row 19 (admin branch): admin POST into an existing user's namespace creates it",
      path: "bob/admin-made",
      kind: "post",
      withPack: true,
      auth: (t) => basicTokenHeader(t.admin),
      expectStatus: 200,
      expectRow: { owner: "bob", slug: "admin-made" },
    },
    // Upstream masks EVERY PushCreateRepo error as a bare 404 (githttp.go:
    // 235-240 — "TODO: need to refactor PushCreateRepo and its returned
    // errors"). A routeable-but-unusable name passes the gate's alphabet
    // pre-filter (parse.ts REPO_NAME) but fails isUsableRepoName (no
    // consecutive dots) — RepoNameInvalidError used to escape this seam as
    // an uncaught 500; it now joins the masked-404 family beside the
    // collision arm above.
    {
      label: "masked 404: POST of a routeable-but-invalid name (a..b) is not a 500",
      path: "alice/a..b",
      kind: "post",
      auth: (t) => basicTokenHeader(t.alice),
      expectStatus: 404,
      expectBody: "Repository not found",
    },
  ];

  it.each(cases.map((c) => [c.label, c] as const))("%s", async (_label, matrixCase) => {
    const tokens = await seedTokens();

    const url = `https://example.com/${matrixCase.path}.git/${
      matrixCase.kind === "probe" ? "info/refs?service=git-receive-pack" : "git-receive-pack"
    }`;
    let body: BodyInit = "0000";
    if (matrixCase.kind === "post" && matrixCase.withPack) {
      const { oid, pack } = await buildPack();
      body = buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack);
    }
    const response = await SELF.fetch(url, {
      method: matrixCase.kind === "probe" ? "GET" : "POST",
      headers: {
        ...(matrixCase.auth ? { authorization: matrixCase.auth(tokens) } : {}),
        ...(matrixCase.kind === "post" ? { "content-type": RECEIVE_CT } : {}),
      },
      ...(matrixCase.kind === "post" ? { body } : {}),
    });

    expect(response.status).toBe(matrixCase.expectStatus);
    if (matrixCase.expectChallenge) {
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="Gitea"');
    } else {
      expect(response.headers.get("www-authenticate")).toBeNull();
    }
    if (matrixCase.expectDummyAdvert) {
      expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");
      const body = new TextDecoder().decode(await response.arrayBuffer());
      expect(body).toContain("# service=git-receive-pack");
      expect(body).toContain("capabilities^{}");
    }
    if (matrixCase.expectBody !== undefined) {
      expect(await response.text()).toContain(matrixCase.expectBody);
    }

    const ownerLower = matrixCase.path.split("/")[0];
    const slugLower = matrixCase.path.split("/")[1];
    const rows = await drizzle(env.DB).select().from(repositories).all();
    const created = rows.some((r) => r.ownerNamespace === ownerLower && r.slug === slugLower);
    if (matrixCase.expectRow) {
      expect(created).toBe(true);
    } else {
      expect(created).toBe(false);
    }
  });

  it("row 17: pushing to a nonexistent own-namespace repo creates it and adopts the pushed branch", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;

    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/trunk", oid }], pack);
    const response = await SELF.fetch("https://example.com/alice/first.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    });
    expect(response.status).toBe(200);

    // §2.5.2: the create lands as status='creating' and the gate schedules
    // settleCreatingRepo via waitUntil (timing depends on the runner, so the
    // assertions below hold whether settle already ran or runs here).
    const service = new RepoService(env.DB);
    const creating = await service.getBySlug("alice", "first");
    if (creating) await settleCreatingRepo(env, creating.id, "alice/first");

    const settled = await service.getBySlug("alice", "first");
    expect(settled?.status).toBe("ready");
    expect(settled?.isEmpty).toBe(false);
    expect(settled?.defaultBranch).toBe("trunk"); // first-push adoption
    expect(settled?.storageKey).toMatch(/^r_/);
    expect(await drizzle(env.DB).select().from(repoCounters).all()).toHaveLength(1);

    // The repo is now a normal servable repo (the registry was seeded by the
    // engine's receive upsert): the advert shows the pushed branch.
    const advert = await SELF.fetch("https://example.com/alice/first.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(advert.status).toBe(200);
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toContain(oid);
  });

  it("§2.5.2: the creating state guards the crash window (status/is_empty/private defaults)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const service = new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") });
    const row = await service.create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "midcrash",
      isPrivate: true,
      status: "creating",
    });
    expect(row.status).toBe("creating");
    expect(row.isEmpty).toBe(true);
    expect(row.visibility).toBe("private"); // DefaultPushCreatePrivate
    expect(row.defaultBranch).toBe("main");
    expect(row.storageKey).toBe(`r_${row.id}`); // same-transaction derivation
  });

  it("row 17 undo: a receive that lands no ref deletes the status='creating' row again (§2.5.2)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;

    // Command-less POST ("0000"): the create lands, the receive commits no
    // ref → the settle hook must delete the row (conditional on
    // status='creating' AND is_empty).
    const response = await SELF.fetch("https://example.com/alice/void.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: "0000",
    });
    expect(response.status).toBe(200);

    const service = new RepoService(env.DB);
    const creating = await service.getBySlug("alice", "void");
    if (creating) await settleCreatingRepo(env, creating.id, "alice/void");
    expect(await service.getBySlug("alice", "void")).toBeNull();
  });

  it("§2.5.2: a tag-only first push keeps the row — the create survives empty-unborn and the tag reads back", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;

    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/tags/v1", oid }], pack);
    const response = await SELF.fetch("https://example.com/alice/tagonly.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    });
    expect(response.status).toBe(200);

    // The gate schedules settleCreatingRepo via waitUntil (timing depends on
    // the runner, so the assertions below hold whether settle already ran or
    // runs here — the settle is idempotent on the settled row).
    const service = new RepoService(env.DB);
    const creating = await service.getBySlug("alice", "tagonly");
    if (creating) await settleCreatingRepo(env, creating.id, "alice/tagonly");

    // Upstream posture (services/repository/push.go): the tag arm (:100-139)
    // records tags/notifications and nothing else — pushNewBranch (:255-270)
    // is branch-only — so a tag-only push-create repo SURVIVES. The undo arm
    // may only fire when NO ref of any namespace landed.
    const settled = await service.getBySlug("alice", "tagonly");
    expect(settled).not.toBeNull();
    expect(settled?.status).toBe("ready"); // the create is real, not lingering 'creating'
    // The empty-unborn posture stays coherent (upstream keeps IsEmpty=true;
    // the unborn HEAD falls back to the unchanged default branch).
    expect(settled?.isEmpty).toBe(true);
    expect(settled?.defaultBranch).toBe("main");
    expect(settled?.storageKey).toMatch(/^r_/);
    expect(await drizzle(env.DB).select().from(repoCounters).all()).toHaveLength(1); // dependents intact

    // The client's success is honest: the tag reads back through the advert.
    const advert = await SELF.fetch("https://example.com/alice/tagonly.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(advert.status).toBe(200);
    const advertBody = new TextDecoder().decode(await advert.arrayBuffer());
    expect(advertBody).toContain("refs/tags/v1");
    expect(advertBody).toContain(oid);

    // ...and through the v1 API (repoListTags renders from the engine refs —
    // the tag-only settled repo is a servable empty repo, not a vanished one).
    const apiTags = await SELF.fetch("https://example.com/api/v1/repos/alice/tagonly/tags", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(apiTags.status).toBe(200);
    expect(await apiTags.json()).toMatchObject([{ name: "v1", commit: { sha: oid } }]);
  });

  it("§2.5.2: a branch+tag first push settles on the branch (the tag rides along)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;

    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody(
      [
        { ref: "refs/heads/dev", oid },
        { ref: "refs/tags/v1", oid },
      ],
      pack,
    );
    const response = await SELF.fetch("https://example.com/alice/mixed.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    });
    expect(response.status).toBe(200);

    const service = new RepoService(env.DB);
    const creating = await service.getBySlug("alice", "mixed");
    if (creating) await settleCreatingRepo(env, creating.id, "alice/mixed");

    // The branch arm is unchanged by a tag's presence in the ref list.
    const settled = await service.getBySlug("alice", "mixed");
    expect(settled?.status).toBe("ready");
    expect(settled?.isEmpty).toBe(false);
    expect(settled?.defaultBranch).toBe("dev"); // first-push adoption

    const advert = await SELF.fetch("https://example.com/alice/mixed.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(advert.status).toBe(200);
    const advertBody = new TextDecoder().decode(await advert.arrayBuffer());
    expect(advertBody).toContain("refs/heads/dev");
    expect(advertBody).toContain("refs/tags/v1");
  });

  it("row 18/20: the 'push to create is not enabled' 403s have no live branch (documented divergence)", async () => {
    // cf-gitea defaults user push-create ON (SPEC-0003 §2.4 divergence) and
    // org push-create ON for grant holders — asserted here as documentation:
    // an authenticated own-namespace probe never 403s.
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const response = await SELF.fetch(
      "https://example.com/alice/enabled.git/info/refs?service=git-receive-pack",
      { headers: { authorization: basicTokenHeader(token) } },
    );
    expect(response.status).toBe(200);
  });

  it("row 19: an org member holding the repo-create grant push-creates into the org's namespace", async () => {
    const owner = await seedVerifiedUser({ username: "OrgOwner" });
    const member = await seedVerifiedUser({ username: "OrgScribe" });
    const orgs = new OrgService(env.DB);
    const teams = new TeamsService(env.DB);
    const org = await orgs.createOrg({ name: "acme", ownerId: owner.id });
    // The §3.4 tier-2 grant arm: a can_create_org_repo team; addTeamMember
    // adds the org membership (role='member') alongside the team row.
    const creators = await teams.createTeam(org, { name: "creators", permission: "read", can_create_org_repo: true });
    await teams.addTeamMember(creators, member.id);
    expect(await orgs.canCreateOrgRepo(org.id, member.id)).toBe(true);

    const token = (await mintFor(member.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const response = await SELF.fetch("https://example.com/acme/fresh.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/trunk", oid }], pack),
    });
    expect(response.status).toBe(200);

    // The row lands under the ORG (owner namespace 'acme', ownerId = the org
    // row), private by DefaultPushCreatePrivate; §2.5.2 settle runs on the
    // runner here (production: ctx.waitUntil), and re-running it is
    // idempotent — both timing windows settle the row.
    const service = new RepoService(env.DB);
    const creating = await service.getBySlug("acme", "fresh");
    expect(creating).not.toBeNull();
    expect(creating?.ownerId).toBe(org.id);
    if (creating) await settleCreatingRepo(env, creating.id, "acme/fresh");
    const settled = await service.getBySlug("acme", "fresh");
    expect(settled?.ownerNamespace).toBe("acme");
    expect(settled?.ownerId).toBe(org.id);
    expect(settled?.status).toBe("ready");
    expect(settled?.isEmpty).toBe(false);
    expect(settled?.defaultBranch).toBe("trunk"); // first-push adoption
    expect(settled?.visibility).toBe("private");
    expect(await drizzle(env.DB).select().from(repoCounters).all()).toHaveLength(1);
  });

  it("row 20: an org member WITHOUT the repo-create grant POSTing into the org's namespace 404s (no row)", async () => {
    const owner = await seedVerifiedUser({ username: "OrgOwner" });
    const member = await seedVerifiedUser({ username: "OrgReader" });
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "acme", ownerId: owner.id });
    await orgs.addMember(org.id, member.id, { role: "member" });
    expect(await orgs.canCreateOrgRepo(org.id, member.id)).toBe(false);

    const token = (await mintFor(member.id, "w", "write:repository")).plaintext;
    const response = await SELF.fetch("https://example.com/acme/nope.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: "0000",
    });
    // Upstream's masked shape (githttp.go:235-240): plain "Repository not
    // found", no challenge — and nothing created.
    expect(response.status).toBe(404);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("Repository not found");
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await new RepoService(env.DB).getBySlug("acme", "nope")).toBeNull();
  });

  it("§4.1: a push-create racing an existing row re-reads and receives normally (unique-violation loser)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;

    // The winner's row already exists (ready): the loser's create throws
    // RepoNameCollisionError → re-read → normal authorized receive.
    const service = new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") });
    await service.create({ owner: { id: alice.id, usernameLower: "alice" }, name: "raced", isPrivate: false });

    const response = await SELF.fetch("https://example.com/alice/raced.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: "0000",
    });
    expect(response.status).toBe(200);
    expect(await service.getBySlug("alice", "raced")).not.toBeNull();
  });

  it("transitional passthrough: GIT_TOKEN credentials keep the engine's create-by-push (e2e population)", async () => {
    const token = env.GIT_TOKEN;
    const response = await SELF.fetch(
      "https://example.com/demo/unregistered-lifecycle.git/info/refs?service=git-receive-pack",
      { headers: { authorization: basicHeader("x", token) } },
    );
    // The gate must NOT 401/403 on the missing D1 row when the credential is
    // engine-style: the engine hook decides (this is what keeps the e2e
    // suite's no-D1-row repos working).
    expect(response.status).toBe(200);
    expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);
  });

  it("drops a malformed Base64 Authorization header into the passthrough (no challenge leak)", async () => {
    const response = await SELF.fetch(
      "https://example.com/alice/garbage.git/git-receive-pack",
      {
        method: "POST",
        headers: { authorization: "Basic !!!not-base64!!!", "content-type": RECEIVE_CT },
        body: "0000",
      },
    );
    // Unparseable credentials behave like the GIT_TOKEN population: the
    // engine hook fails closed with its own 401.
    expect(response.status).toBe(401);
  });
});
