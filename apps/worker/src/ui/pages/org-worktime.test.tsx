/**
 * The org worktime page's module-level suite (PORT-FIRST: the route lives
 * behind the orchestrator's index.ts fold — the recipe is the module
 * header's; the seams drive directly, the admin-users-avatar.ts pattern).
 *
 * Coverage (upstream at the pin: web.go:1015's route behind reqSignIn +
 * OrgAssignment{RequireOwner}, routers/web/org/worktime.go's parseOrgTimes
 * + Worktime switch, models/organization/org_worktime.go's three
 * aggregates, worktime.tmpl's DOM):
 *
 *   - THE BY-REPOS SUMS (org_worktime.go:16-32): the
 *     tracked_time⋈issue⋈repository join grouped per repo, `deleted`
 *     entries excluded, out-of-range entries excluded (BOTH bounds
 *     inclusive — :29-30's Gte/Lte pair and the 1440min-1s tail,
 *     worktime.go:38), a foreign owner's repo excluded.
 *   - THE DEFAULTS (worktime.go:20-26): absent from/to fall to the current
 *     month's first day / today (the injected clock's UTC parts), `by`
 *     defaults to repos (the switch's default branch).
 *   - THE BY-MEMBERS SUMS (org_worktime.go:91-107): per-user sums ordered
 *     sum_time DESC.
 *   - THE BY-MILESTONES SHAPE (org_worktime.go:45-90): the LEFT JOIN's
 *     no-milestone null arm, the in-process re-sort (repo, deadline with
 *     NULL first, id), the HideRepoName pass, the cleared deadline.
 *   - THE SERVERERROR ARM (worktime.go:31-38): a junk or calendar-illegal
 *     date is `{outcome: "error"}` (upstream's 500), never a silent
 *     default.
 *   - THE OWNER GATE (the require-owner group): anonymous → the login 303
 *     (reqSignIn, web.go:1103), a signed-in non-owner (member or
 *     outsider) → forbidden (the 404 shell), the owner and a SITE ADMIN
 *     non-member → page, an unknown org → missing, a renamed org → the
 *     307 (the resolveOrgTeamsRequest ladder's order).
 *   - THE RENDER (worktime.tmpl): pageClass `organization times`, the
 *     hidden `by` echo, the defaulted date inputs, the switcher's active
 *     arm + preserved from/to hrefs, the three tables' rows and links
 *     (milestones' suppressed repo cell + the bare-dash null arm), the
 *     empty placeholder's colspan, and Sec2Hours verbatim
 *     (modules/util/sec_to_time.go).
 *
 * Fixture discipline (the org-settings matrix pattern): tables wiped per
 * test (children first), ids captured at seed time — never hardcoded.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { issues, milestones, repositories, trackedTimes, userRedirects } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  loadOrgWorktimeData,
  OrgWorktimePage,
  orgWorktimeLocale,
  parseWorktimeBy,
  parseWorktimeDate,
  parseWorktimeRange,
  resolveOrgWorktimePage,
  secToHours,
  type WorktimeMilestonesRow,
  type WorktimeMembersRow,
  type WorktimeReposRow,
} from "./org-worktime";

// --- fixtures ----------------------------------------------------------------

/** The fixed clock: 2026-06-15T12:00:00Z — the defaulted range is
 *  2026-06-01 .. 2026-06-15. */
const NOW = new Date("2026-06-15T12:00:00Z");
const ORG_CREATED = new Date("2026-01-01T00:00:00Z");

/** Tables the fixtures touch (children first). The tracked-time table is
 *  upstream's singular `tracked_time` (schema.ts's sqliteTable name). */
const FIXTURE_TABLES = [
  "sessions",
  "tracked_time",
  "issues",
  "milestones",
  "repo_settings",
  "repositories",
  "org_members",
  "user_redirects",
  "users",
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

function ctxFor(viewer: Viewer): UiContext {
  return { viewer, origin: "https://test.local", assets: shellAssetsFromManifest(manifest) };
}

const OWNER_VIEWER: Viewer = { kind: "user", id: 0, username: "worktime-owner", isAdmin: false };

interface Seeded {
  ownerId: number;
  memberId: number;
  outsiderId: number;
  adminId: number;
  orgId: number;
  orgUsername: string;
}

async function seedUsersAndOrg(): Promise<Seeded> {
  const owner = await seedVerifiedUser({ username: "worktime-owner" });
  const member = await seedVerifiedUser({ username: "worktime-member" });
  const outsider = await seedVerifiedUser({ username: "worktime-out" });
  const admin = await seedVerifiedUser({ username: "worktime-admin", isAdmin: true });
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({
    name: "acme-worktime",
    ownerId: owner.id,
    visibility: "public",
    now: ORG_CREATED,
  });
  await orgs.addMember(org.id, member.id, { isPublic: true, now: ORG_CREATED });
  return {
    ownerId: owner.id,
    memberId: member.id,
    outsiderId: outsider.id,
    adminId: admin.id,
    orgId: org.id,
    orgUsername: org.username,
  };
}

/** A minimal repositories row (the issue-tables-t2 seed's shape —
 *  deterministic TEXT ids). */
async function seedRepo(id: string, slug: string, ownerId: number): Promise<void> {
  await drizzle(env.DB)
    .insert(repositories)
    .values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: "acme-worktime",
      ownerId,
      slug,
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: ORG_CREATED,
    })
    .run();
}

interface SeededWorktime {
  base: Seeded;
  /** The June 2026 in-range window the suite seeds against. */
  range: { from: string; to: string };
  expectedRepos: WorktimeReposRow[];
  expectedMembers: WorktimeMembersRow[];
  expectedMilestones: WorktimeMilestonesRow[];
}

/** The full aggregate fixture: two org repos (one with a milestone-carrying
 *  issue, one without + one with), a foreign repo, and tracked entries
 *  probing every filter arm. */
async function seedWorktime(): Promise<SeededWorktime> {
  const base = await seedUsersAndOrg();
  const foreign = await seedVerifiedUser({ username: "worktime-foreign" });
  await seedRepo("9001", "alpha", base.orgId);
  await seedRepo("9002", "beta", base.orgId);
  await seedRepo("9003", "gamma", foreign.id); // the foreign-owner exclusion

  const m1 = await drizzle(env.DB)
    .insert(milestones)
    .values({ repoId: "9001", name: "M1", deadlineAt: new Date("2026-07-01T00:00:00Z"), createdAt: ORG_CREATED })
    .returning({ id: milestones.id })
    .all();
  const m2 = await drizzle(env.DB)
    .insert(milestones)
    .values({ repoId: "9002", name: "M2", deadlineAt: null, createdAt: ORG_CREATED })
    .returning({ id: milestones.id })
    .all();
  const milestone1 = m1[0]!;
  const milestone2 = m2[0]!;

  const issueIndexes = new Map<string, number>();
  const seedIssue = (repoId: string, milestoneId: number | null) => {
    const index = (issueIndexes.get(repoId) ?? 0) + 1;
    issueIndexes.set(repoId, index);
    return drizzle(env.DB)
      .insert(issues)
      .values({ repoId, index, title: "t", posterId: base.ownerId, milestoneId, createdAt: ORG_CREATED })
      .returning({ id: issues.id })
      .all()
      .then((rows) => rows[0]!.id);
  };
  const i1 = await seedIssue("9001", milestone1.id); // milestone-carrying
  const i2 = await seedIssue("9001", null); // no milestone
  const i3 = await seedIssue("9002", milestone2.id);
  const i4 = await seedIssue("9003", null); // foreign repo

  const at = (iso: string) => new Date(iso);
  const insertTime = (issueId: number, userId: number, seconds: number, created: Date, deleted = false) =>
    drizzle(env.DB).insert(trackedTimes).values({ issueId, userId, seconds, createdAt: created, deleted }).run();

  // The alpha repo (issue i1 milestone-carrying + i2 bare):
  await insertTime(i1, base.memberId, 3600, at("2026-06-02T12:00:00Z"));
  await insertTime(i1, base.ownerId, 1800, at("2026-06-03T09:00:00Z"));
  await insertTime(i1, base.memberId, 10, at("2026-06-01T00:00:00Z")); // the range's first second
  await insertTime(i2, base.ownerId, 20, at("2026-06-15T23:59:59Z")); // the ending day's last second — INCLUDED
  // The excluded arms:
  await insertTime(i2, base.memberId, 600, at("2026-05-31T23:59:59Z")); // before the range
  await insertTime(i2, base.memberId, 120, at("2026-06-16T00:00:30Z")); // after the ending day
  await insertTime(i3, base.memberId, 300, at("2026-06-05T00:00:00Z"), true); // deleted
  await insertTime(i4, base.memberId, 999, at("2026-06-05T00:00:00Z")); // foreign owner
  // The beta repo's one live entry:
  await insertTime(i3, base.memberId, 45, at("2026-06-06T00:00:00Z"));

  return {
    base,
    range: { from: "2026-06-01", to: "2026-06-15" },
    // alpha = 3600 + 1800 + 10 + 20 = 5430; beta = 45; gamma never appears.
    expectedRepos: [
      { repoName: "alpha", sumTime: 5430 },
      { repoName: "beta", sumTime: 45 },
    ],
    // bob (member) = 3600 + 10 + 45 = 3655; alice (owner) = 1800 + 20 = 1820.
    expectedMembers: [
      { userName: "worktime-member", sumTime: 3655 },
      { userName: "worktime-owner", sumTime: 1820 },
    ],
    // Sorted: alpha's undated (null) group FIRST (deadline 0), then alpha/M1
    // (hideRepoName), then beta/M2.
    expectedMilestones: [
      { repoName: "alpha", milestoneName: null, milestoneId: null, sumTime: 20, hideRepoName: false },
      { repoName: "alpha", milestoneName: "M1", milestoneId: milestone1.id, sumTime: 5410, hideRepoName: true },
      { repoName: "beta", milestoneName: "M2", milestoneId: milestone2.id, sumTime: 45, hideRepoName: false },
    ],
  };
}

async function loadBy(params: Record<string, string>, orgId: number, now: Date = NOW) {
  const orgs = new OrgService(env.DB);
  const org = (await orgs.getOrgById(orgId))!;
  return loadOrgWorktimeData(env.DB, org, new URLSearchParams(params), now);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the aggregates ------------------------------------------------------------

describe("the by-repos aggregate (org_worktime.go:16-32)", () => {
  it("sums per repo over the join; deleted, out-of-range and foreign-owner entries excluded", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({ by: "repos", from: seeded.range.from, to: seeded.range.to }, seeded.base.orgId);
    expect(loaded.outcome).toBe("ok");
    if (loaded.outcome !== "ok") return;
    expect(loaded.data.by).toBe("repos");
    expect(loaded.data.rows).toEqual(seeded.expectedRepos);
  });

  it("absent from/to default to the month start and today (parseOrgTimes), by defaults to repos", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({}, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    expect(loaded.data.by).toBe("repos");
    expect(loaded.data.rangeFrom).toBe("2026-06-01");
    expect(loaded.data.rangeTo).toBe("2026-06-15");
    expect(loaded.data.rows).toEqual(seeded.expectedRepos);
  });

  it("the ending day is inclusive: 23:59:59 counts, the next day's 00:00:30 does not (worktime.go:38)", async () => {
    const seeded = await seedWorktime();
    // The fixture's 20s entry sits at 2026-06-15T23:59:59Z and 120s at
    // 2026-06-16T00:00:30Z — the expected sums already pin both arms.
    const loaded = await loadBy({ by: "repos", from: seeded.range.from, to: seeded.range.to }, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    const alpha = (loaded.data.rows as WorktimeReposRow[]).find((row) => row.repoName === "alpha");
    expect(alpha?.sumTime).toBe(5430); // 3600+1800+10+20 — no 600, no 120
  });
});

describe("the by-members aggregate (org_worktime.go:91-107)", () => {
  it("sums per user and orders sum_time DESC", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({ by: "members", from: seeded.range.from, to: seeded.range.to }, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    expect(loaded.data.rows).toEqual(seeded.expectedMembers);
  });
});

describe("the by-milestones aggregate (org_worktime.go:45-90)", () => {
  it("groups repo+milestone with the LEFT JOIN null arm, the deadline-first sort, HideRepoName", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({ by: "milestones", from: seeded.range.from, to: seeded.range.to }, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    expect(loaded.data.rows).toEqual(seeded.expectedMilestones);
  });
});

// --- the range parse ------------------------------------------------------------

describe("the range parse (worktime.go:16-42)", () => {
  it("junk and calendar-illegal dates are the ServerError arm (upstream's 500, not a default)", () => {
    expect(parseWorktimeRange(new URLSearchParams("from=junk&to=2026-06-15"), NOW)).toEqual({ outcome: "error" });
    expect(parseWorktimeRange(new URLSearchParams("from=2026-06-01&to=2026-02-31"), NOW)).toEqual({ outcome: "error" });
    expect(parseWorktimeDate("2026-02-31")).toBeNull(); // the constructor-roll arm
    expect(parseWorktimeDate("2026-6-01")).toBeNull(); // the shape arm
  });

  it("the unix range is inclusive of the ending day's last second", () => {
    const parsed = parseWorktimeRange(new URLSearchParams("from=2026-06-01&to=2026-06-03"), NOW);
    if (parsed.outcome !== "ok") throw new Error("expected ok");
    expect(parsed.range.unixFrom).toBe(Date.UTC(2026, 5, 1) / 1000);
    expect(parsed.range.unixTo).toBe(Date.UTC(2026, 5, 3) / 1000 + 86_399);
  });

  it("by folds unknown values onto repos (the switch's default branch)", () => {
    expect(parseWorktimeBy(new URLSearchParams())).toBe("repos");
    expect(parseWorktimeBy(new URLSearchParams("by=milestones"))).toBe("milestones");
    expect(parseWorktimeBy(new URLSearchParams("by=members"))).toBe("members");
    expect(parseWorktimeBy(new URLSearchParams("by=junk"))).toBe("repos");
  });
});

describe("Sec2Hours (util.SecToHours verbatim)", () => {
  it("formats hours + minutes, seconds only when neither is nonzero", () => {
    // formatTime pluralizes by appending "s" to the unit name
    // (sec_to_time.go:32-44) — "minutes"/"seconds", never "mins".
    expect(secToHours(9000)).toBe("2 hours 30 minutes");
    expect(secToHours(3600)).toBe("1 hour");
    expect(secToHours(2700)).toBe("45 minutes");
    expect(secToHours(30)).toBe("30 seconds");
    expect(secToHours(0)).toBe("");
    expect(secToHours(5400)).toBe("1 hour 30 minutes");
  });
});

// --- the owner gate (RequireOwner + reqSignIn) -----------------------------------

describe("the owner gate (resolveOrgWorktimePage — RequireOwner, org.go:144)", () => {
  it("the anonymous viewer is the login 303 (reqSignIn, web.go:1103)", async () => {
    const seeded = await seedWorktime();
    const outcome = await resolveOrgWorktimePage(env.DB, seeded.base.orgUsername, { kind: "anonymous" }, "/acme-worktime/worktime", "by=members");
    expect(outcome.kind).toBe("signin");
    if (outcome.kind !== "signin") return;
    expect(outcome.location).toBe(`/login?redirect_to=${encodeURIComponent("/acme-worktime/worktime?by=members")}`);
  });

  it("a signed-in NON-OWNER (member or outsider) is forbidden — the 404 shell arm", async () => {
    const seeded = await seedWorktime();
    const member: Viewer = { kind: "user", id: seeded.base.memberId, username: "worktime-member", isAdmin: false };
    const outsider: Viewer = { kind: "user", id: seeded.base.outsiderId, username: "worktime-out", isAdmin: false };
    expect((await resolveOrgWorktimePage(env.DB, seeded.base.orgUsername, member, "/acme-worktime/worktime", "")).kind).toBe("forbidden");
    expect((await resolveOrgWorktimePage(env.DB, seeded.base.orgUsername, outsider, "/acme-worktime/worktime", "")).kind).toBe("forbidden");
  });

  it("the org owner passes; a SITE ADMIN non-member passes (org.go:118-123's super-access arm)", async () => {
    const seeded = await seedWorktime();
    const owner: Viewer = { kind: "user", id: seeded.base.ownerId, username: "worktime-owner", isAdmin: false };
    const admin: Viewer = { kind: "user", id: seeded.base.adminId, username: "worktime-admin", isAdmin: true };
    const ownerOutcome = await resolveOrgWorktimePage(env.DB, seeded.base.orgUsername, owner, "/acme-worktime/worktime", "");
    expect(ownerOutcome.kind).toBe("page");
    if (ownerOutcome.kind === "page") expect(ownerOutcome.org.id).toBe(seeded.base.orgId);
    expect((await resolveOrgWorktimePage(env.DB, seeded.base.orgUsername, admin, "/acme-worktime/worktime", "")).kind).toBe("page");
  });

  it("an unknown org is missing; a renamed org is the 307 (the resolveOrgTeamsOrg ladder)", async () => {
    const seeded = await seedWorktime();
    expect(
      (await resolveOrgWorktimePage(env.DB, "no-such-org", { kind: "user", id: seeded.base.ownerId, username: "worktime-owner", isAdmin: false }, "/no-such-org/worktime", "")).kind,
    ).toBe("missing");
    await drizzle(env.DB).insert(userRedirects).values({ lowerName: "acme-old", redirectUserId: seeded.base.orgId }).run();
    const renamed = await resolveOrgWorktimePage(
      env.DB,
      "acme-old",
      { kind: "user", id: seeded.base.ownerId, username: "worktime-owner", isAdmin: false },
      "/acme-old/worktime",
      "",
    );
    expect(renamed.kind).toBe("redirect");
    if (renamed.kind === "redirect") expect(renamed.location).toBe("/acme-worktime/worktime");
  });
});

// --- the render (worktime.tmpl) ---------------------------------------------------

describe("the render (worktime.tmpl's DOM)", () => {
  it("carries the pageClass, the org header, the hidden by echo and the defaulted date inputs", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({}, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    const html = renderToString(<OrgWorktimePage ctx={ctxFor(OWNER_VIEWER)} data={loaded.data} />);
    expect(html).toContain('class="page-content organization times"');
    expect(html).toContain('type="hidden" name="by" value="repos"');
    expect(html).toContain('type="date" name="from" value="2026-06-01"');
    expect(html).toContain('type="date" name="to" value="2026-06-15"');
    expect(html).toContain(orgWorktimeLocale.query);
  });

  it("the switcher marks the active arm and every href preserves from/to", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({ by: "members", from: "2026-06-01", to: "2026-06-15" }, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    const html = renderToString(<OrgWorktimePage ctx={ctxFor(OWNER_VIEWER)} data={loaded.data} />);
    // hono/jsx renders `class` ahead of `href`.
    expect(html).toContain('class="active item" href="/acme-worktime/worktime?by=members&amp;from=2026-06-01&amp;to=2026-06-15"');
    expect(html).toContain('class="item" href="/acme-worktime/worktime?by=repos&amp;from=2026-06-01&amp;to=2026-06-15"');
    expect(html).not.toContain('name="by" value="repos"'); // the echo follows the active arm
    expect(html).toContain('name="by" value="members"');
  });

  it("the repos table renders the row links and the Sec2Hours cells", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({ by: "repos", from: seeded.range.from, to: seeded.range.to }, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    const html = renderToString(<OrgWorktimePage ctx={ctxFor(OWNER_VIEWER)} data={loaded.data} />);
    expect(html).toContain('href="/acme-worktime/alpha/issues">alpha</a>');
    expect(html).toContain("1 hour 30 minutes"); // 5430s = 1h 30m 30s → hours+minutes only
    expect(html).toContain("45 seconds");
  });

  it("the milestones table suppresses the repeat repo cell and renders the bare-dash null arm", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({ by: "milestones", from: seeded.range.from, to: seeded.range.to }, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    const html = renderToString(<OrgWorktimePage ctx={ctxFor(OWNER_VIEWER)} data={loaded.data} />);
    // The null-milestone row: the dash cell, no milestone link.
    expect(html).toContain(`>${orgWorktimeLocale.no_milestone}</td>`);
    // The M1 row: the milestone link carries the issue repo + the id.
    const m1 = seeded.expectedMilestones[1]!;
    expect(html).toContain(`href="/acme-worktime/alpha/milestone/${m1.milestoneId}">M1</a>`);
    // The HideRepoName arm: exactly two alpha issue-list links (row 1's repo
    // cell + none on row 2).
    expect((html.match(/\/acme-worktime\/alpha\/issues/g) ?? []).length).toBe(1);
  });

  it("the members table links the profiles; the empty range renders the placeholder colspan", async () => {
    const seeded = await seedWorktime();
    const loaded = await loadBy({ by: "members", from: seeded.range.from, to: seeded.range.to }, seeded.base.orgId);
    if (loaded.outcome !== "ok") throw new Error("expected ok");
    const html = renderToString(<OrgWorktimePage ctx={ctxFor(OWNER_VIEWER)} data={loaded.data} />);
    expect(html).toContain('href="/worktime-member">worktime-member</a>');

    const empty = await loadBy({ by: "repos", from: "2030-01-01", to: "2030-01-02" }, seeded.base.orgId);
    if (empty.outcome !== "ok") throw new Error("expected ok");
    const emptyHtml = renderToString(<OrgWorktimePage ctx={ctxFor(OWNER_VIEWER)} data={empty.data} />);
    expect(emptyHtml).toContain(orgWorktimeLocale.empty);
    expect(emptyHtml).toContain('colspan="2"');
  });
});
