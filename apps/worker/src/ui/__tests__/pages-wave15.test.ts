/**
 * Pages wave 15 route tests (SPEC-0008 U3 extension + SPEC-0013's UI
 * piece): the protected-branches settings family — `/settings/branches`
 * (the rules list), `/settings/branches/edit` (the shared create/edit form,
 * GET keyed by `?rule_name=`), `/settings/branches/{id}/delete` and
 * `/settings/branches/priority` — pages/branch-protection.tsx re-playing
 * the landed `/repos/{owner}/{repo}/branch_protections` arms over the
 * landed service primitives (the module header carries the arm-by-arm
 * citations).
 *
 * Same harness posture as pages-wave2..14: the router is driven directly
 * with the synthetic ASSETS manifest and D1-only fixtures; rules seeded
 * through direct D1 inserts with fixed values, identities riding minted
 * session cookies. The default-branch select's arms (branches.tmpl's
 * SetDefaultBranchPost segment — the wave-branches-default pass) are the
 * exception: they read ENGINE content, so `alice/wave15-defbranch` seeds a
 * multi-branch repo through the REAL receive flow (the wave-17 recipe) and
 * the select/apply arms run at the module seam (loadDefaultBranchOptions /
 * renderBranchProtectionListPage / applyDefaultBranchForm). 21b91ce then
 * mounted the family's route arms — the GET passes `branchOptions` and the
 * POST (upstream SetDefaultBranchPost) runs the sameOriginGuard →
 * settingsGate → archived-404 → action-switch → applyDefaultBranchForm
 * ladder onto the bare 303 — and the route-level describe below pins that
 * ladder over the engine-backed fixture.
 *
 * Gate postures under test: the settings pages' admin gate (anonymous 303,
 * signed-in non-admin 404) on every page and write; the archived refusals
 * (the list/form render the warning, the POSTs 404 — RepoMustNotBeArchived's
 * posture); the create arm's 403 duplicate text and the name/team
 * resolution 422 texts surfaced inline; the edit arm's stored-field
 * preservation for the unrendered arms (SPEC-0013 §6); the priority op's
 * 1-based renumber with the foreign-id no-op; the default-branch select's
 * PrepareBranchList option order, the marked default, the empty-repo
 * disabled arm and the service seam's arguments (same-name no-op, the
 * missing-branch refusal, the production wiring's D1+engine-head write),
 * and the mounted POST's route ladder (the 303 write with both truths
 * moved + the re-render, the gate trio, the switch-default and
 * ghost-branch 404s, the same-name no-op over the wire).
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { protectedBranches, repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { emptyRuleConfig, parseRuleConfig, serializeRuleConfig } from "../../services/branch-protection";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { TeamsService } from "../../api/routes/org-teams";
import { settleCreatingRepo } from "../../git-http/gate";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv, manifest } from "./harness";
import { applyDefaultBranchForm, loadDefaultBranchOptions, renderBranchProtectionListPage } from "../pages/branch-protection";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const formPost = (path: string, body: Record<string, string | string[]>, cookie?: string, origin = "https://test.local"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(origin === "" ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(
    Object.entries(body).flatMap(([key, value]) => (Array.isArray(value) ? value.map((entry) => [key, entry] as const) : [[key, value] as const])),
  ).toString(),
});

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

// --- fixtures -----------------------------------------------------------------

interface Wave15Fixture {
  ownerCookie: string; // alice — owns wave15
  adminCookie: string; // wave15boss — site admin
  palCookie: string; // wave15bob — unrelated signed-in viewer
  morganCookie: string; // bporg's owner
  plainRuleId: number; // "main" on alice/wave15
  globRuleId: number; // "release/*" on alice/wave15
  editRuleId: number; // the edit-preservation rule on alice/wave15
  deleteRuleId: number; // the delete rule on alice/wave15
  orgTeamId: number;
}

let wave15Fixture: Wave15Fixture | null = null;

/** Three fixed commits for the engine-backed default-branch fixture repo:
 *  main sits at tips[1], feature/one at tips[2], release/1 at tips[0]. */
const WAVE15_DEFBRANCH_COMMITS: SeedCommit[] = [1, 2, 3].map((n, index) => ({
  message: `wave15-defbranch: commit ${n}`,
  time: T0 + index * 60,
  files: [{ path: `f${n}.txt`, content: `content ${n}\n` }],
}));

/** Idempotent multi-branch engine seed for `alice/wave15-defbranch` (the
 *  wave-17 recipe verbatim: one pack through the REAL receive flow —
 *  ensureSeededRepo only ever lands main, and the default-branch select's
 *  option arms need the multi-branch ref set; the multi-ref first push
 *  lands HEAD on the alphabetically-first ref, so D1's default_branch is
 *  pinned to "main" like every deterministic column). */
async function ensureWave15EngineRepo(): Promise<void> {
  const db = drizzle(env.DB);
  const repoName = "alice/wave15-defbranch";
  const alice = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get())!;
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave15-defbranch")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave15-defbranch", "write:repository")).plaintext;
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    const { tips, pack } = await buildHistoryPack(WAVE15_DEFBRANCH_COMMITS);
    const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody(
        [
          { ref: "refs/heads/main", oid: tips[1] as string },
          { ref: "refs/heads/feature/one", oid: tips[2] as string },
          { ref: "refs/heads/release/1", oid: tips[0] as string },
        ],
        pack,
      ),
    });
    const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || responseBody.includes("ng ")) {
      throw new Error(`wave15-defbranch seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
    }
  }
  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15-defbranch")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave15-defbranch",
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, repoName);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  if (row.defaultBranch !== "main" || row.visibility !== "public") {
    // Both pins matter: the REAL receive flow PUSH-CREATES the row first
    // (the gate's push-create defaults — isPrivate: true per upstream
    // DefaultPushCreatePrivate, status 'creating' until the settle), so the
    // create call below never runs and the row would stay private — the
    // seam arms ride owner/admin cookies so only the gate ladder's
    // anonymous-303 arm ever noticed. Pin the public repo the create call
    // intended (the direct-D1 fixture convention — the archived toggle).
    await db.update(repositories).set({ defaultBranch: "main", visibility: "public" }).where(eq(repositories.id, row.id));
  }
}

async function ensureWave15Fixtures(): Promise<Wave15Fixture> {
  if (wave15Fixture !== null) return wave15Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);

  // Alice (the repo owner) + the identities (unique rows — the wave-14
  // block's shape). The other suites seed alice; this block never pushes
  // engine content, so seed any missing row directly.
  for (const extra of [
    { username: "alice", isAdmin: false },
    { username: "wave15boss", isAdmin: true },
    { username: "wave15bob", isAdmin: false },
    { username: "wave15morgan", isAdmin: false },
  ] as const) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get()) === undefined) {
      await seedVerifiedUser({ username: extra.username, isAdmin: extra.isAdmin });
    }
  }
  const alice = (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())!;
  const morgan = (await db.select().from(users).where(eq(users.usernameLower, "wave15morgan")).get())!;

  // The org + team for the org-repo arms (before the repos — the org repo
  // is org-OWNED: ownerNamespace "bporg"). createOrg returns the full
  // record; the miss arm creates it.
  const orgs = new OrgService(env.DB);
  const org = (await orgs.getOrgByUsername("bporg")) ?? (await orgs.createOrg({ name: "bporg", ownerId: morgan.id, visibility: "public", now: new Date(T0 * 1000) }));

  // The row-only repos: alice/wave15 (user-owned) and bporg/wave15-org
  // (org-owned — the team inputs' gate).
  const repos = new RepoService(env.DB);
  for (const spec of [
    { owner: { id: alice.id, usernameLower: "alice" }, slug: "wave15" },
    { owner: { id: org.id, usernameLower: "bporg" }, slug: "wave15-org" },
  ]) {
    if (
      (await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, spec.owner.usernameLower), eq(repositories.slug, spec.slug)))
        .get()) === undefined
    ) {
      await repos.create({ owner: spec.owner, name: spec.slug, isPrivate: false, status: "ready" });
    }
  }
  const wave15 = (
    await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15")))
      .get()
  )!;
  const orgRepoRow = (
    await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "bporg"), eq(repositories.slug, "wave15-org")))
      .get()
  )!;

  const teamSvc = new TeamsService(env.DB);
  const existingTeams = await teamSvc.listTeams({ orgId: org.id });
  const developers = existingTeams.items.find((team) => team.name === "Developers") ?? (await teamSvc.createTeam(org, { name: "Developers", permission: "write" }));
  await teamSvc.addTeamRepo(developers, orgRepoRow.id);

  // The rules on alice/wave15, seeded DIRECTLY for deterministic ids
  // (T0-pinned stamps; the list renders no timestamps). `editRule` carries
  // the unrendered arms (status checks, signed commits, file patterns,
  // codeowner block) the edit write must preserve.
  const ruleOf = async (name: string) => db.select().from(protectedBranches).where(and(eq(protectedBranches.repoId, wave15.id), eq(protectedBranches.ruleName, name))).get();
  if ((await ruleOf("main")) === undefined) {
    await db.insert(protectedBranches).values([
      {
        repoId: wave15.id,
        ruleName: "main",
        priority: 1,
        rules: serializeRuleConfig({ ...emptyRuleConfig(), requiredApprovals: 1, dismissStaleApprovals: true }),
        createdAt: new Date(T0 * 1000),
        updatedAt: new Date(T0 * 1000),
      },
      {
        repoId: wave15.id,
        ruleName: "release/*",
        priority: 2,
        rules: serializeRuleConfig({ ...emptyRuleConfig(), canPush: true, enableWhitelist: true, whitelistUserIds: [alice.id] }),
        createdAt: new Date((T0 + 1) * 1000),
        updatedAt: new Date((T0 + 1) * 1000),
      },
      {
        repoId: wave15.id,
        ruleName: "edit-me",
        priority: 3,
        rules: serializeRuleConfig({
          ...emptyRuleConfig(),
          enableStatusCheck: true,
          statusCheckContexts: ["ci/test"],
          requireSignedCommits: true,
          protectedFilePatterns: "secrets/**",
          blockOnCodeownerReviews: true,
        }),
        createdAt: new Date((T0 + 2) * 1000),
        updatedAt: new Date((T0 + 2) * 1000),
      },
      {
        repoId: wave15.id,
        ruleName: "delete-me",
        priority: 4,
        rules: serializeRuleConfig(emptyRuleConfig()),
        createdAt: new Date((T0 + 3) * 1000),
        updatedAt: new Date((T0 + 3) * 1000),
      },
    ]);
  }
  const plain = await ruleOf("main");
  const glob = await ruleOf("release/*");
  const editRule = await ruleOf("edit-me");
  const deleteRule = await ruleOf("delete-me");

  // The engine-backed repo for the default-branch select's arms (after the
  // rule seeds — the push may settle the row concurrently with nothing).
  await ensureWave15EngineRepo();

  wave15Fixture = {
    ownerCookie: await mintSession(env.DB, alice.id),
    adminCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave15boss")).get())!.id),
    palCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave15bob")).get())!.id),
    morganCookie: await mintSession(env.DB, morgan.id),
    plainRuleId: plain!.id,
    globRuleId: glob!.id,
    editRuleId: editRule!.id,
    deleteRuleId: deleteRule!.id,
    orgTeamId: developers.id,
  };
  return wave15Fixture;
}

beforeAll(async () => {
  await ensureWave15Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-15 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the protected-branches shapes", () => {
    expect(parseUiRoute("/octo/hello/settings/branches")).toEqual({ family: "settings-branches", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/settings/branches/edit")).toEqual({ family: "settings-branch-edit", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/settings/branches/priority")).toEqual({ family: "settings-branch-priority", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/settings/branches/42/delete")).toEqual({
      family: "settings-branch-delete",
      owner: "octo",
      repo: "hello",
      id: 42,
    });
    // "007" parses as 7 (the PathParamInt64 convention).
    expect(parseUiRoute("/octo/hello/settings/branches/007/delete")).toEqual({
      family: "settings-branch-delete",
      owner: "octo",
      repo: "hello",
      id: 7,
    });
    // The trailing-slash form classifies to the same shape.
    expect(parseUiRoute("/octo/hello/settings/branches/")).toEqual({ family: "settings-branches", owner: "octo", repo: "hello" });
    expect(handlesUiRoute("/octo/hello/settings/branches")).toBe(true);
  });

  it("leaves junk tails and the rest of the settings space with the engine", () => {
    expect(parseUiRoute("/octo/hello/settings/branches/abc")).toBeNull();
    expect(parseUiRoute("/octo/hello/settings/branches/42/edit")).toBeNull();
    expect(parseUiRoute("/octo/hello/settings/branches/edit/more")).toBeNull();
    expect(parseUiRoute("/octo/hello/settings/branches/priority/extra")).toBeNull();
    // Window-2d (b54f709) mounted the deploy-keys tab — the stale null
    // updated to the claimed shape (the settingsnav-fold's disclosure).
    expect(parseUiRoute("/octo/hello/settings/keys")).toEqual({ family: "settings-keys", owner: "octo", repo: "hello" });
  });
});

// --- the list page ---------------------------------------------------------------

describe("GET /{owner}/{repo}/settings/branches (the rules list)", () => {
  it("gates like the settings pages: anonymous 303, non-admin 404", async () => {
    const fixture = await ensureWave15Fixtures();
    const anon = await fetchUi("/alice/wave15/settings/branches");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave15%2Fsettings%2Fbranches");
    const pal = await fetchUi("/alice/wave15/settings/branches", withCookie(fixture.palCookie));
    expect(pal.status).toBe(404);
  });

  it("renders the rules in priority order with the badge, ranks and counts", async () => {
    const fixture = await ensureWave15Fixtures();
    for (const cookie of [fixture.ownerCookie, fixture.adminCookie]) {
      const res = await fetchUi("/alice/wave15/settings/branches", withCookie(cookie));
      expect(res.status).toBe(200);
      const html = await res.text();
      // Upstream's literal discriminator (branches.tmpl's layout_head at
      // this pin) and the header + add button.
      expect(html).toContain("page-content repository settings edit");
      expect(html).toContain("Branch Protection");
      expect(html).toContain('href="/alice/wave15/settings/branches/edit"');
      // Priority order: main (plain) first, release/* second; the ranks and
      // the glob badge (IsRuleNameSpecial). The order check slices from the
      // list container — the default-branch select's menu (above the list)
      // carries its own ">main<" option text.
      const listHtml = html.slice(html.indexOf("protected-branches-list"));
      expect(listHtml.indexOf(">main<")).toBeLessThan(listHtml.indexOf(">release/*<"));
      expect(html).toContain("<span class=\"ui tiny basic label\">#1</span>");
      expect(html).toContain("<span class=\"ui tiny basic label\">#2</span>");
      expect(html).toContain('<span class="ui tiny label">glob</span>');
      // The counts lines (the list read).
      expect(html).toContain("required approvals: 1");
      expect(html).toContain("push allowlist: 1 user, 0 teams");
      // The per-row controls: edit keyed by ?rule_name=, the move forms'
      // reordered hidden id lists, the delete form.
      expect(html).toContain(`href="/alice/wave15/settings/branches/edit?rule_name=release%2F*"`);
      expect(html).toContain(`action="/alice/wave15/settings/branches/priority"`);
      expect(html).toContain(`aria-label="Move this rule up the priority order"`);
      expect(html).toContain(`action="/alice/wave15/settings/branches/${fixture.globRuleId}/delete"`);
      // The navbar item (the wave-15 SettingsNav addition).
      expect(html).toContain('href="/alice/wave15/settings/branches"');
    }
  });

  it("renders the save flash from the ?rule_name= redirect param (display-only)", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi("/alice/wave15/settings/branches?rule_name=main", withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
    // The quotes render HTML-escaped (hono/jsx's escaper).
    expect(await res.text()).toContain("Branch protection for rule &quot;main&quot; has been updated.");
  });

  it("renders the archived warning instead of the list", async () => {
    const fixture = await ensureWave15Fixtures();
    const db = drizzle(env.DB);
    const row = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15"))).get())!;
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, row.id));
    try {
      const res = await fetchUi("/alice/wave15/settings/branches", withCookie(fixture.ownerCookie));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Branch settings are not available if the repo is archived.");
      // branches.tmpl's IsArchived arm hides BOTH segments (the template's
      // whole content sits inside the else) — the default-branch select too.
      expect(html).not.toContain("protected-branches-list");
      expect(html).not.toContain("Update Default Branch");
    } finally {
      await db.update(repositories).set({ isArchived: false }).where(eq(repositories.id, row.id));
    }
  });
});

// --- the create/edit form ---------------------------------------------------------

describe("GET /{owner}/{repo}/settings/branches/edit (the form)", () => {
  it("gates like the list and renders the create form by default", async () => {
    const fixture = await ensureWave15Fixtures();
    const anon = await fetchUi("/alice/wave15/settings/branches/edit");
    expect(anon.status).toBe(303);
    const pal = await fetchUi("/alice/wave15/settings/branches/edit", withCookie(fixture.palCookie));
    expect(pal.status).toBe(404);
    const res = await fetchUi("/alice/wave15/settings/branches/edit", withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // Upstream's literal discriminator (protected_branch.tmpl's layout_head).
    expect(html).toContain("page-content repository settings branches");
    expect(html).toContain("Add New Rule");
    expect(html).toContain('name="rule_id" value="0"');
    expect(html).toContain('id="rule_name" name="rule_name" type="text" value="" required=""');
    // The honest subset: the enforced arms render, the unenforced ones do not.
    expect(html).toContain('name="enable_push"');
    expect(html).toContain('id="required_approvals" name="required_approvals" type="number" min="0" value="0"');
    expect(html).toContain('id="enable_approvals_whitelist" name="enable_approvals_whitelist" type="checkbox"');
    expect(html).toContain('id="block_on_outdated_branch" name="block_on_outdated_branch" type="checkbox"');
    expect(html).not.toContain('name="protected_file_patterns"');
    expect(html).not.toContain('name="require_signed_commits"');
    expect(html).not.toContain('name="enable_status_check"');
    expect(html).not.toContain('name="block_on_codeowner_reviews"');
    // The unenforced-arms note renders.
    expect(html).toContain("stored-but-unenforced arms");
    // User-owned repo: no team inputs.
    expect(html).not.toContain('name="whitelist_teams"');
  });

  it("binds the stored rule on ?rule_name= (readonly name, the edit header)", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi("/alice/wave15/settings/branches/edit?rule_name=edit-me", withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // The header's quotes render HTML-escaped (hono/jsx's escaper).
    expect(html).toContain("Branch Protection Rules for Branch &#39;<b>edit-me</b>&#39;");
    expect(html).toContain('id="rule_name" name="rule_name" type="text" value="edit-me" readonly=""');
    expect(html).toContain('name="rule_id" value="' + String(fixture.editRuleId) + '"');
    // The stored bindings (the ToBranchProtection render reduced to the form).
    expect(html).toContain('id="required_approvals" name="required_approvals" type="number" min="0" value="0"');
    expect(html).toContain('id="enable_push_none" name="enable_push" type="radio" value="none" checked=""');
    // The unrendered arms are absent from the form even when stored.
    expect(html).not.toContain('name="status_check_contexts"');
  });

  it("falls back to the create form for an unknown ?rule_name= (upstream's nil-rule arm)", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi("/alice/wave15/settings/branches/edit?rule_name=nope", withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Add New Rule");
  });

  it("renders the team inputs on an org-owned repo only", async () => {
    const fixture = await ensureWave15Fixtures();
    // The org repo's form renders for the site admin here (the org owner's
    // admin grant rides the Owners-team bridge through the landed
    // isRepositoryAdmin — see pages-wave16.test.ts; this test pins the
    // team-input rendering on an org-owned repo, whichever principal).
    const orgPage = await fetchUi("/bporg/wave15-org/settings/branches/edit", withCookie(fixture.adminCookie));
    expect(orgPage.status).toBe(200);
    const orgHtml = await orgPage.text();
    expect(orgHtml).toContain('id="whitelist_teams" name="whitelist_teams"');
    expect(orgHtml).toContain('id="approvals_whitelist_teams" name="approvals_whitelist_teams"');
  });

  it("renders the archived warning instead of the form", async () => {
    const fixture = await ensureWave15Fixtures();
    const db = drizzle(env.DB);
    const row = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15"))).get())!;
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, row.id));
    try {
      const res = await fetchUi("/alice/wave15/settings/branches/edit", withCookie(fixture.ownerCookie));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Branch settings are not available if the repo is archived.");
    } finally {
      await db.update(repositories).set({ isArchived: false }).where(eq(repositories.id, row.id));
    }
  });
});

describe("POST /{owner}/{repo}/settings/branches/edit (the create arm)", () => {
  const createForm = {
    rule_id: "0",
    rule_name: "golang",
    enable_push: "none",
    enable_force_push: "none",
    enable_deletion: "none",
    required_approvals: "2",
    dismiss_stale_approvals: "on",
    block_on_outdated_branch: "on",
  };

  it("creates through the landed arm (priority MAX+1) and 303s onto the flash target", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi("/alice/wave15/settings/branches/edit", formPost("/alice/wave15/settings/branches/edit", createForm, fixture.ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave15/settings/branches?rule_name=golang");
    const db = drizzle(env.DB);
    const repo = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15"))).get())!;
    const row = (await db.select().from(protectedBranches).where(and(eq(protectedBranches.repoId, repo.id), eq(protectedBranches.ruleName, "golang"))).get())!;
    expect(row.priority).toBe(5); // MAX(stored 1..4) + 1
    const config = parseRuleConfig(row.rules);
    expect(config.requiredApprovals).toBe(2);
    expect(config.dismissStaleApprovals).toBe(true);
    expect(config.blockOnOutdatedBranch).toBe(true);
    expect(config.canPush).toBe(false);
    // The flash renders on the list (the quotes HTML-escaped).
    const list = await fetchUi("/alice/wave15/settings/branches?rule_name=golang", withCookie(fixture.ownerCookie));
    expect(await list.text()).toContain("Branch protection for rule &quot;golang&quot; has been updated.");
  });

  it("re-renders the duplicate-name 403, the empty-name and negative-approvals guards inline", async () => {
    const fixture = await ensureWave15Fixtures();
    const duplicate = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost("/alice/wave15/settings/branches/edit", { ...createForm, rule_name: "main" }, fixture.ownerCookie),
    );
    expect(duplicate.status).toBe(200);
    const dupHtml = await duplicate.text();
    expect(dupHtml).toContain("Branch protection already exist");
    expect(dupHtml).toContain('value="main"'); // the kept submission

    const empty = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost("/alice/wave15/settings/branches/edit", { ...createForm, rule_name: "" }, fixture.ownerCookie),
    );
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("Rule name cannot be empty.");

    const negative = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost("/alice/wave15/settings/branches/edit", { ...createForm, required_approvals: "-1" }, fixture.ownerCookie),
    );
    expect(negative.status).toBe(200);
    expect(await negative.text()).toContain("Required approvals cannot be negative.");
  });

  it("422s an unknown user or team with the API's exact texts, re-rendered inline", async () => {
    const fixture = await ensureWave15Fixtures();
    const ghost = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost(
        "/alice/wave15/settings/branches/edit",
        { ...createForm, rule_name: "with-ghost", enable_push: "whitelist", whitelist_users: "ghost" },
        fixture.ownerCookie,
      ),
    );
    expect(ghost.status).toBe(200);
    expect(await ghost.text()).toContain("user does not exist [uid: 0, name: ghost]");

    const noTeam = await fetchUi(
      "/bporg/wave15-org/settings/branches/edit",
      formPost(
        "/bporg/wave15-org/settings/branches/edit",
        { ...createForm, rule_name: "with-team", enable_push: "whitelist", whitelist_users: "wave15morgan", whitelist_teams: "nope" },
        fixture.adminCookie,
      ),
    );
    expect(noTeam.status).toBe(200);
    expect(await noTeam.text()).toContain("team does not exist [org_id");
  });

  it("resolves names to ids, sanitizes the lists and applies the push/deletion conjunctions", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost(
        "/alice/wave15/settings/branches/edit",
        {
          rule_id: "0",
          rule_name: "allowlisted",
          enable_push: "whitelist",
          whitelist_users: "alice,wave15bob",
          enable_force_push: "none",
          enable_deletion: "whitelist", // push is armed — no coercion
          deletion_allowlist_users: "wave15bob",
          required_approvals: "0",
        },
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    const db = drizzle(env.DB);
    const repo = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15"))).get())!;
    const row = (await db.select().from(protectedBranches).where(and(eq(protectedBranches.repoId, repo.id), eq(protectedBranches.ruleName, "allowlisted"))).get())!;
    const config = parseRuleConfig(row.rules);
    const aliceId = (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())!.id;
    expect(config.canPush).toBe(true);
    expect(config.enableWhitelist).toBe(true);
    // The M4 sanitization (zero comparison side on create): alice keeps the
    // list through the owner's WRITE grant; bob — a registered user with no
    // collaborator row and no team grant — is silently dropped (a public
    // repo's implicit pull does not count, GetUserIDsWithAnyUnitAccess).
    expect(config.whitelistUserIds).toEqual([aliceId]);
    expect(config.canDelete).toBe(true);
    expect(config.enableDeletionAllowlist).toBe(true);
    expect(config.deletionAllowlistUserIds).toEqual([]);
  });

  it("gates the write and refuses cross-origin posts", async () => {
    const fixture = await ensureWave15Fixtures();
    const anon = await fetchUi("/alice/wave15/settings/branches/edit", formPost("/alice/wave15/settings/branches/edit", createForm));
    expect(anon.status).toBe(303);
    const pal = await fetchUi("/alice/wave15/settings/branches/edit", formPost("/alice/wave15/settings/branches/edit", createForm, fixture.palCookie));
    expect(pal.status).toBe(404);
    const crossOrigin = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost("/alice/wave15/settings/branches/edit", createForm, fixture.ownerCookie, "https://evil.example"),
    );
    expect(crossOrigin.status).toBe(403);
  });
});

describe("POST /{owner}/{repo}/settings/branches/edit (the edit arm)", () => {
  it("patches the rendered fields and preserves the unrendered stored arms", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost(
        "/alice/wave15/settings/branches/edit",
        {
          rule_id: String(fixture.editRuleId),
          rule_name: "edit-me", // readonly field; the stored name keys the arm
          enable_push: "all",
          enable_force_push: "none",
          enable_deletion: "none",
          required_approvals: "3",
          block_on_official_review_requests: "on",
        },
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave15/settings/branches?rule_name=edit-me");
    const db = drizzle(env.DB);
    const repo = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15"))).get())!;
    const row = (await db.select().from(protectedBranches).where(and(eq(protectedBranches.repoId, repo.id), eq(protectedBranches.ruleName, "edit-me"))).get())!;
    const config = parseRuleConfig(row.rules);
    expect(config.canPush).toBe(true);
    expect(config.enableWhitelist).toBe(false);
    expect(config.requiredApprovals).toBe(3);
    expect(config.blockOnOfficialReviewRequests).toBe(true);
    // The unrendered arms kept their stored values (SPEC-0013 §6).
    expect(config.enableStatusCheck).toBe(true);
    expect(config.statusCheckContexts).toEqual(["ci/test"]);
    expect(config.requireSignedCommits).toBe(true);
    expect(config.protectedFilePatterns).toBe("secrets/**");
    expect(config.blockOnCodeownerReviews).toBe(true);
  });

  it("clears the bypass and deletion allowlists when their flags come off", async () => {
    const fixture = await ensureWave15Fixtures();
    const db = drizzle(env.DB);
    const alice = (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())!;
    // Seed a rule carrying bypass + deletion allowlists.
    const repo = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15"))).get())!;
    await db.insert(protectedBranches).values({
      repoId: repo.id,
      ruleName: "clear-me",
      priority: 6,
      rules: serializeRuleConfig({
        ...emptyRuleConfig(),
        canPush: true,
        enableBypassAllowlist: true,
        bypassAllowlistUserIds: [alice.id],
        canDelete: true,
        enableDeletionAllowlist: true,
        deletionAllowlistUserIds: [alice.id],
      }),
      createdAt: new Date((T0 + 5) * 1000),
      updatedAt: new Date((T0 + 5) * 1000),
    });
    const seeded = (await db.select().from(protectedBranches).where(and(eq(protectedBranches.repoId, repo.id), eq(protectedBranches.ruleName, "clear-me"))).get())!;
    const res = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost(
        "/alice/wave15/settings/branches/edit",
        {
          rule_id: String(seeded.id),
          rule_name: "clear-me",
          enable_push: "all",
          enable_force_push: "none",
          enable_deletion: "none",
          required_approvals: "0",
        },
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    const config = parseRuleConfig((await db.select().from(protectedBranches).where(eq(protectedBranches.id, seeded.id)).get())!.rules);
    expect(config.enableBypassAllowlist).toBe(false);
    expect(config.bypassAllowlistUserIds).toEqual([]);
    expect(config.enableDeletionAllowlist).toBe(false);
    expect(config.deletionAllowlistUserIds).toEqual([]);
  });

  it("404-shells a missing or foreign rule id", async () => {
    const fixture = await ensureWave15Fixtures();
    const missing = await fetchUi(
      "/alice/wave15/settings/branches/edit",
      formPost(
        "/alice/wave15/settings/branches/edit",
        { rule_id: "999999", rule_name: "x", enable_push: "none", required_approvals: "0" },
        fixture.ownerCookie,
      ),
    );
    expect(missing.status).toBe(404);
  });

  it("404s the archived write (RepoMustNotBeArchived's posture)", async () => {
    const fixture = await ensureWave15Fixtures();
    const db = drizzle(env.DB);
    const row = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15"))).get())!;
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, row.id));
    try {
      const res = await fetchUi(
        "/alice/wave15/settings/branches/edit",
        formPost("/alice/wave15/settings/branches/edit", { rule_id: "0", rule_name: "x", required_approvals: "0" }, fixture.ownerCookie),
      );
      expect(res.status).toBe(404);
    } finally {
      await db.update(repositories).set({ isArchived: false }).where(eq(repositories.id, row.id));
    }
  });
});

// --- the delete + priority writes ---------------------------------------------------

describe("POST /{owner}/{repo}/settings/branches/{id}/delete (the delete write)", () => {
  it("deletes the rule and 303s onto the list", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi(
      `/alice/wave15/settings/branches/${fixture.deleteRuleId}/delete`,
      formPost(`/alice/wave15/settings/branches/${fixture.deleteRuleId}/delete`, {}, fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave15/settings/branches");
    expect(await drizzle(env.DB).select().from(protectedBranches).where(eq(protectedBranches.id, fixture.deleteRuleId)).get()).toBeUndefined();
  });

  it("404-shells a missing id and answers GET with the 405", async () => {
    const fixture = await ensureWave15Fixtures();
    const missing = await fetchUi(
      "/alice/wave15/settings/branches/999999/delete",
      formPost("/alice/wave15/settings/branches/999999/delete", {}, fixture.ownerCookie),
    );
    expect(missing.status).toBe(404);
    const wrongMethod = await fetchUi(`/alice/wave15/settings/branches/${fixture.plainRuleId}/delete`);
    expect(wrongMethod.status).toBe(405);
    const anon = await fetchUi(`/alice/wave15/settings/branches/${fixture.plainRuleId}/delete`, formPost(`/alice/wave15/settings/branches/${fixture.plainRuleId}/delete`, {}));
    expect(anon.status).toBe(303);
    const pal = await fetchUi(
      `/alice/wave15/settings/branches/${fixture.plainRuleId}/delete`,
      formPost(`/alice/wave15/settings/branches/${fixture.plainRuleId}/delete`, {}, fixture.palCookie),
    );
    expect(pal.status).toBe(404);
  });
});

describe("POST /{owner}/{repo}/settings/branches/priority (the reorder write)", () => {
  it("renumbers 1-based in the posted order, foreign ids no-op, and 303s back", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi(
      "/alice/wave15/settings/branches/priority",
      formPost(
        "/alice/wave15/settings/branches/priority",
        { ids: [String(fixture.globRuleId), "424242", String(fixture.plainRuleId)] },
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave15/settings/branches");
    const db = drizzle(env.DB);
    const glob = (await db.select().from(protectedBranches).where(eq(protectedBranches.id, fixture.globRuleId)).get())!;
    const plain = (await db.select().from(protectedBranches).where(eq(protectedBranches.id, fixture.plainRuleId)).get())!;
    // The renumber is INDEX-based (upstream verbatim): the foreign id
    // consumes its rank slot, so the listed rules land on 1 and 3.
    expect(glob.priority).toBe(1);
    expect(plain.priority).toBe(3);
    // The foreign id wrote nothing (the repo_id guard).
    expect(await db.select().from(protectedBranches).where(eq(protectedBranches.id, 424242)).get()).toBeUndefined();
    // The list renders the new first-match order (sliced to the list
    // container — the select's own ">main<" option sits above it).
    const html = await (await fetchUi("/alice/wave15/settings/branches", withCookie(fixture.ownerCookie))).text();
    const listHtml = html.slice(html.indexOf("protected-branches-list"));
    expect(listHtml.indexOf(">release/*<")).toBeLessThan(listHtml.indexOf(">main<"));
    // Restore the seeded order for the later a11y renders.
    await fetchUi(
      "/alice/wave15/settings/branches/priority",
      formPost("/alice/wave15/settings/branches/priority", { ids: [String(fixture.plainRuleId), String(fixture.globRuleId)] }, fixture.ownerCookie),
    );
  });

  it("answers GET with the 405 and gates the write", async () => {
    const fixture = await ensureWave15Fixtures();
    const wrongMethod = await fetchUi("/alice/wave15/settings/branches/priority");
    expect(wrongMethod.status).toBe(405);
    const anon = await fetchUi("/alice/wave15/settings/branches/priority", formPost("/alice/wave15/settings/branches/priority", { ids: "1" }));
    expect(anon.status).toBe(303);
    const pal = await fetchUi(
      "/alice/wave15/settings/branches/priority",
      formPost("/alice/wave15/settings/branches/priority", { ids: "1" }, fixture.palCookie),
    );
    expect(pal.status).toBe(404);
  });
});

// --- the default-branch select (branches.tmpl:8-30, SetDefaultBranchPost) -----------

describe("the default-branch select (branches.tmpl's SetDefaultBranchPost arm)", () => {
  const defBranchRow = async (): Promise<RepoRow> =>
    (await drizzle(env.DB).select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15-defbranch"))).get())!;

  /** A minimal UiContext for the direct renderer calls — the same fields the
   *  route's GET handler assembles (the renderers are pure; no DB reads). */
  const directCtx = (repo: RepoRow): UiContext => ({
    viewer: { kind: "user", id: 1, username: "alice", isAdmin: false },
    origin: "https://test.local",
    repo,
    assets: shellAssetsFromManifest(manifest),
  });

  it("loads the options from the engine branch list, the current default topped (PrepareBranchList's port)", async () => {
    await ensureWave15Fixtures();
    const options = await loadDefaultBranchOptions(env, await defBranchRow());
    // Byte-sorted engine names with the default moved to the top
    // (repo.go:598-618's "always put default branch on the top").
    expect(options).toEqual(["main", "feature/one", "release/1"]);
  });

  it("renders the segment: menu options in order, the marked default, enabled submit on a pushed repo", async () => {
    await ensureWave15Fixtures();
    const repo = await defBranchRow();
    const html = renderBranchProtectionListPage({
      ctx: directCtx(repo),
      data: { rules: [], isOrg: false, savedRule: null, branchOptions: await loadDefaultBranchOptions(env, repo) },
    });
    // The segment's shape (branches.tmpl:8-30): the header, the desc, the
    // POST onto the page itself with the hidden action field.
    expect(html).toContain(">Default Branch</h4>");
    expect(html).toContain("Select a default branch for code commits.");
    expect(html).toContain('action="/alice/wave15-defbranch/settings/branches" method="post"');
    expect(html).toContain('name="action" value="default_branch"');
    // The menu: PrepareBranchList order — main first, then byte-sorted; the
    // current default carries the selected mark (the dropdown's hidden input
    // + `.default text` arm).
    const mainIdx = html.indexOf('value="main" selected=""');
    const featureIdx = html.indexOf('value="feature/one"');
    const releaseIdx = html.indexOf('value="release/1"');
    expect(mainIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeLessThan(featureIdx);
    expect(featureIdx).toBeLessThan(releaseIdx);
    // Pushed repo: the submit enabled — no disabled attribute.
    expect(html).toContain(">Update Default Branch</button>");
    expect(html).not.toContain('class="ui primary button" disabled');
    // The target-branch help line rides the form's tail.
    expect(html).toContain("Pull requests can use different default target branch");
  });

  it("renders the empty-repo arm: the lone unborn default, disabled submit", async () => {
    await ensureWave15Fixtures();
    const repo = (await drizzle(env.DB).select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15"))).get())!;
    expect(repo.isEmpty).toBe(true);
    const html = renderBranchProtectionListPage({
      ctx: directCtx(repo),
      data: { rules: [], isOrg: false, savedRule: null, branchOptions: [] },
    });
    // The unborn default still rides the form (upstream's hidden input +
    // `.default text` render it verbatim), the menu carries no engine
    // options, the button is disabled (branches.tmpl:26's IsEmpty arm).
    expect(html).toContain('value="main" selected=""');
    expect(html).not.toContain('value="feature/one"');
    expect(html).toContain('class="ui primary button" disabled=""');
  });

  it("route-level: the mounted list renders the segment; the unborn default is the lone option", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await fetchUi("/alice/wave15/settings/branches", withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">Default Branch</h4>");
    expect(html).toContain('name="action" value="default_branch"');
    expect(html).toContain('name="branch"');
    expect(html).toContain('class="ui primary button" disabled=""');
    // The route-level menu stays the lone default on this D1-only repo — the
    // same bytes before and after the mount wave passes branchOptions.
    expect(html).toContain('value="main" selected=""');
  });

  it("same-name POST is the service's early no-op: applied, nothing written", async () => {
    await ensureWave15Fixtures();
    const repo = await defBranchRow();
    const calls: Array<[string, string]> = [];
    const before = repo.updatedAt;
    const result = await applyDefaultBranchForm(env, repo, "main", (repoId, branch): Promise<unknown> => {
      calls.push([repoId, branch]);
      return Promise.resolve();
    });
    expect(result).toEqual({ outcome: "applied", branch: "main" });
    expect(calls).toEqual([]); // SetRepoDefaultBranch's early return (branch.go:708-710)
    expect((await defBranchRow()).updatedAt!.getTime()).toBe(before!.getTime());
  });

  it("passes the repo id and the chosen branch to the landed service (the seam's arguments)", async () => {
    await ensureWave15Fixtures();
    const repo = await defBranchRow();
    const calls: Array<[string, string]> = [];
    const result = await applyDefaultBranchForm(env, repo, "feature/one", (repoId, branch): Promise<unknown> => {
      calls.push([repoId, branch]);
      return Promise.resolve();
    });
    expect(result).toEqual({ outcome: "applied", branch: "feature/one" });
    expect(calls).toEqual([[repo.id, "feature/one"]]);
  });

  it("a branch the engine does not know is `missing` and the service is not called", async () => {
    await ensureWave15Fixtures();
    const repo = await defBranchRow();
    const calls: Array<[string, string]> = [];
    const result = await applyDefaultBranchForm(env, repo, "ghost", (repoId, branch): Promise<unknown> => {
      calls.push([repoId, branch]);
      return Promise.resolve();
    });
    expect(result).toEqual({ outcome: "missing", branch: "ghost" });
    expect(calls).toEqual([]); // IsBranchExist's not-exist arm — the handler 404-shells
  });

  it("the production wiring writes D1 and moves the engine head, then restores", async () => {
    await ensureWave15Fixtures();
    const repo = await defBranchRow();
    // The default (production) seam: D1 first, the engine's setHead riding.
    const applied = await applyDefaultBranchForm(env, repo, "release/1");
    expect(applied).toEqual({ outcome: "applied", branch: "release/1" });
    expect((await defBranchRow()).defaultBranch).toBe("release/1");
    expect((await env.REPO.getByName("alice/wave15-defbranch").listRefs()).head).toBe("refs/heads/release/1");
    // Restore the fixture (the priority test's own convention — later a11y
    // renders ride the pinned default).
    const after = await defBranchRow();
    expect((await applyDefaultBranchForm(env, after, "main")).outcome).toBe("applied");
    expect((await defBranchRow()).defaultBranch).toBe("main");
    expect((await env.REPO.getByName("alice/wave15-defbranch").listRefs()).head).toBe("refs/heads/main");
  });
});

// --- the mounted default-branch POST (route-level arms over the seam) ---------------

describe("POST /{owner}/{repo}/settings/branches (the mounted default-branch write's route arms)", () => {
  const defBranchRow = async (): Promise<RepoRow> =>
    (await drizzle(env.DB).select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave15-defbranch"))).get())!;

  /** The route POST on the engine-backed fixture (the select's own form
   *  target; same-origin by default, cookie omitted for anonymous). */
  const defBranchPost = (body: Record<string, string>, cookie?: string, origin = "https://test.local"): Promise<Response> =>
    fetchUi("/alice/wave15-defbranch/settings/branches", formPost("/alice/wave15-defbranch/settings/branches", body, cookie, origin));

  it("happy path: 303 onto the settings path with D1 + engine head moved and the GET re-render marking the new default", async () => {
    const fixture = await ensureWave15Fixtures();
    // Upstream's success arm: SetRepoDefaultBranch then ctx.Redirect onto
    // the request path (default_branch.go:37-50; the update_settings_success
    // flash is the bare-303 reduction — the delete/priority precedent).
    const res = await defBranchPost({ action: "default_branch", branch: "feature/one" }, fixture.ownerCookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave15-defbranch/settings/branches");
    // The production wiring wrote BOTH truths: D1's metadata column (the
    // source of truth) and the engine's HEAD via the wired setHead dep
    // (RepoService.setDefaultBranch — the PATCH /api repos wiring shape).
    expect((await defBranchRow()).defaultBranch).toBe("feature/one");
    expect((await env.REPO.getByName("alice/wave15-defbranch").listRefs()).head).toBe("refs/heads/feature/one");
    // The GET re-render: PrepareBranchList re-tops the new default and the
    // select's selected mark moved with it (repo.go:598-618 + branches.tmpl's
    // marked-selection arm).
    const html = await (await fetchUi("/alice/wave15-defbranch/settings/branches", withCookie(fixture.ownerCookie))).text();
    const featureIdx = html.indexOf('value="feature/one" selected=""');
    expect(featureIdx).toBeGreaterThan(-1);
    expect(featureIdx).toBeLessThan(html.indexOf('value="main"'));
    // Restore through the same route (the seam test's restore convention —
    // the later a11y render rides the pinned main default).
    const back = await defBranchPost({ action: "default_branch", branch: "main" }, fixture.ownerCookie);
    expect(back.status).toBe(303);
    expect((await defBranchRow()).defaultBranch).toBe("main");
    expect((await env.REPO.getByName("alice/wave15-defbranch").listRefs()).head).toBe("refs/heads/main");
  });

  it("gate ladder: cross-origin 403, anonymous login 303, signed-in non-writer 404 shell — nothing written", async () => {
    const fixture = await ensureWave15Fixtures();
    const body = { action: "default_branch", branch: "release/1" };
    // The §2.8 sameOriginGuard runs FIRST: the cross-origin write 403s
    // before identity resolution or any write (the edit POST's posture).
    const crossOrigin = await defBranchPost(body, fixture.ownerCookie, "https://evil.example");
    expect(crossOrigin.status).toBe(403);
    // Anonymous: the settings gate's login round-trip, the GET list's exact
    // redirect target (settingsGate's viewer.kind arm — the pathname rides
    // ?redirect_to=).
    const anon = await defBranchPost(body);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave15-defbranch%2Fsettings%2Fbranches");
    // A signed-in non-writer (no collaborator row, no grant, not a site
    // admin) 404-shells — existence hidden (settingsGate's canAdminRepo arm).
    const pal = await defBranchPost(body, fixture.palCookie);
    expect(pal.status).toBe(404);
    // No gated arm reached the write.
    expect((await defBranchRow()).defaultBranch).toBe("main");
    expect((await env.REPO.getByName("alice/wave15-defbranch").listRefs()).head).toBe("refs/heads/main");
  });

  it("404s the archived repo's write (RepoMustNotBeArchived's posture)", async () => {
    const fixture = await ensureWave15Fixtures();
    const db = drizzle(env.DB);
    const row = await defBranchRow();
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, row.id));
    try {
      // The archived check runs BEFORE the form parse (the handler's ladder
      // order) — a well-formed write still 404-shells and writes nothing.
      const res = await defBranchPost({ action: "default_branch", branch: "feature/one" }, fixture.ownerCookie);
      expect(res.status).toBe(404);
      expect((await defBranchRow()).defaultBranch).toBe("main");
    } finally {
      await db.update(repositories).set({ isArchived: false }).where(eq(repositories.id, row.id));
    }
  });

  it("404s a foreign action value (the switch's default arm, default_branch.go:51-53) — nothing written", async () => {
    const fixture = await ensureWave15Fixtures();
    const res = await defBranchPost({ action: "rename_repo", branch: "feature/one" }, fixture.ownerCookie);
    expect(res.status).toBe(404);
    expect((await defBranchRow()).defaultBranch).toBe("main");
    expect((await env.REPO.getByName("alice/wave15-defbranch").listRefs()).head).toBe("refs/heads/main");
  });

  it("404-shells a branch the engine does not know (IsErrBranchNotExist's arm, default_branch.go:39-40) — nothing written", async () => {
    const fixture = await ensureWave15Fixtures();
    const before = await defBranchRow();
    const res = await defBranchPost({ action: "default_branch", branch: "ghost" }, fixture.ownerCookie);
    expect(res.status).toBe(404);
    // The existence check reads the SAME engine branch list the select
    // renders — the service never ran (updatedAt untouched, head unmoved).
    const after = await defBranchRow();
    expect(after.defaultBranch).toBe("main");
    expect(after.updatedAt!.getTime()).toBe(before.updatedAt!.getTime());
    expect((await env.REPO.getByName("alice/wave15-defbranch").listRefs()).head).toBe("refs/heads/main");
  });

  it("the same-name POST 303s bare with nothing written (SetRepoDefaultBranch's early return over the wire)", async () => {
    const fixture = await ensureWave15Fixtures();
    const before = await defBranchRow();
    const res = await defBranchPost({ action: "default_branch", branch: "main" }, fixture.ownerCookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave15-defbranch/settings/branches");
    // branch.go:708-710's early no-op: still success, the service (and its
    // updatedAt write + head move) never ran.
    const after = await defBranchRow();
    expect(after.defaultBranch).toBe("main");
    expect(after.updatedAt!.getTime()).toBe(before.updatedAt!.getTime());
    expect((await env.REPO.getByName("alice/wave15-defbranch").listRefs()).head).toBe("refs/heads/main");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-15 a11y smoke", () => {
  it("every new page passes the structural rules for its gate-admitted viewer", async () => {
    const fixture = await ensureWave15Fixtures();
    for (const [path, init] of [
      ["/alice/wave15/settings/branches", withCookie(fixture.ownerCookie)],
      ["/alice/wave15/settings/branches?rule_name=main", withCookie(fixture.adminCookie)],
      ["/alice/wave15/settings/branches/edit", withCookie(fixture.ownerCookie)],
      ["/alice/wave15/settings/branches/edit?rule_name=main", withCookie(fixture.adminCookie)],
      ["/bporg/wave15-org/settings/branches/edit", withCookie(fixture.adminCookie)],
      // The engine-backed repo's list (the default-branch select's DOM over a
      // pushed repo — the enabled submit arm).
      ["/alice/wave15-defbranch/settings/branches", withCookie(fixture.ownerCookie)],
    ] as Array<[string, RequestInit]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
