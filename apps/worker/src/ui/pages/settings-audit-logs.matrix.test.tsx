/**
 * The settings AUDIT LOG pages' tests (the census R13 module — GET
 * /{owner}/{repo}/settings/audit_logs + GET /{org}/settings/audit_logs at
 * ui/index.ts over pages/settings-audit-logs.tsx, the shared renderer over
 * the landed M4 findAuditEvents): the filter parse matrix
 * (SearchOptionsFromRequest port), the actor resolution (unknown name
 * matches NOTHING), the loader's scope isolation and keyset pager (forward
 * walk, the exact-multiple empty-boundary clamp, the walk bound), the DOM
 * contract of both mounts (the shared list's form/table/pager, the row
 * anatomy incl. impersonation/credential/deleted arms), and the deferred
 * mounted-route matrix (the real uiRouter on minted sessions): the repo
 * settingsGate posture (anonymous 303 / non-admin 404 shell / admin 200)
 * and the org require-owner prologue, the GET-only 405s, and the route
 * claim pins. Audit rows seed ONLY through the LANDED emit seam
 * (emitAudit/auditEventInsert) plus the slice-one instrumentation's own
 * emits (RepoService.create / OrgService.createOrg) — never raw SQL.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { orgMembers, repoSettings, users } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { AuditActions, auditEventInsert, emitAudit, type AuditEventInput } from "../../services/audit";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { Viewer } from "../viewer";
import { formatMonitorFullTime } from "./admin-monitor";
import {
  AUDIT_PAGE_SIZE,
  AUDIT_PAGE_WALK_MAX,
  auditPageHref,
  loadSettingsAuditLogs,
  OrgSettingsAuditLogsPage,
  parseAuditFilters,
  renderOrgSettingsAuditLogsPage,
  renderRepoSettingsAuditLogsPage,
  RepoSettingsAuditLogsPage,
  resolveAuditActorId,
  settingsAuditLogsLocale,
  type AuditScopePair,
} from "./settings-audit-logs";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The base fixture stamp — seeded rows carry TS0 + i seconds so the
 *  keyset order (created_unix DESC, id DESC) is deterministic without
 *  relying on the id tiebreak. */
const TS0 = new Date("2026-06-01T00:00:00Z");

/** The signed-in owner viewing the pages (ids assigned at seed time). */
let viewer: Viewer = { kind: "anonymous" };
let ctx: UiContext;

interface SeededUser {
  id: number;
  username: string;
}

async function seedUser(username: string, type: "user" | "org" = "user"): Promise<SeededUser> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      type,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username };
}

let alice: SeededUser;
let bob: SeededUser;
let morgan: SeededUser;
let org: OrgRecord;
let repo: RepoRow; // alice/atlas — the repo-page fixture
let otherRepo: RepoRow; // bob/bux — the isolation fixture (and the walk-bound scope)

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // repo_counters FIRST — the one non-cascading repositories child
  // (0002's FOREIGN KEY ... ON DELETE no action); the rest cascade or
  // stand alone (the tags/applications matrices' wipe idiom).
  for (const table of ["audit_event", "repo_counters", "team_members", "teams", "org_members", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  alice = await seedUser("alice");
  bob = await seedUser("bob");
  morgan = await seedUser("morgan");
  viewer = { kind: "user", id: alice.id, username: alice.username, isAdmin: false };
  ctx = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };
  // The org rides the LANDED createOrg — the instrumentation's
  // organization:create row lands with it (alice receives the owner
  // membership row in the same batch).
  org = await new OrgService(env.DB).createOrg({
    name: "acme",
    ownerId: alice.id,
    visibility: "public",
    now: TS0,
  });
  const repos = new RepoService(env.DB);
  repo = await repos.create({ owner: { id: alice.id, usernameLower: alice.username }, name: "atlas", isPrivate: false });
  otherRepo = await repos.create({ owner: { id: bob.id, usernameLower: bob.username }, name: "bux", isPrivate: false });
  // The repo-settings pages' render contract: ctx.repo resolved (the route
  // prologue's assignment — the DOM tests render the page component
  // directly).
  ctx.repo = repo;
});

/** Seed one audit row through the LANDED emit seam. Defaults shape a
 *  repository-scope row on the atlas fixture; overrides replace any field.
 *  Raw binding in, drizzle wrapped here — the seam takes the wrapped type
 *  (emitAudit's contract; the audit.test.ts seeding idiom). */
async function seedEvent(over: Partial<AuditEventInput>): Promise<void> {
  await emitAudit(drizzle(env.DB), {
    action: AuditActions.RepositoryVisibility,
    actorId: alice.id,
    actorName: alice.username,
    scopeType: "repository",
    scopeId: repo.id,
    scopeName: `${alice.username}/${repo.slug}`,
    origin: "ui",
    ipAddress: "203.0.113.7",
    vars: { scope: `${alice.username}/${repo.slug}`, visibility: "private" },
    ...over,
  });
}

const REPO_SCOPE: AuditScopePair = { type: "repository", id: "00000000-0000-4000-8000-00000000abcd" }; // no rows — every create emits on its own scope

// --- the filter parse (SearchOptionsFromRequest's request half) ---------------

describe("parseAuditFilters (shared/audit/audit.go:37-77's request half)", () => {
  it("defaults: sort DESC, no filters, page 1", () => {
    expect(parseAuditFilters(new URLSearchParams())).toEqual({
      sort: "timestamp_desc",
      action: "",
      actionPrefix: "",
      origin: undefined,
      actor: "",
      page: 1,
      sortExplicit: false,
    });
  });

  it("only the exact timestamp_asc upgrades the sort; junk falls back to DESC (audit.go:39)", () => {
    expect(parseAuditFilters(new URLSearchParams({ sort: "timestamp_asc" })).sort).toBe("timestamp_asc");
    expect(parseAuditFilters(new URLSearchParams({ sort: "timestamp_desc" })).sort).toBe("timestamp_desc");
    expect(parseAuditFilters(new URLSearchParams({ sort: "junk" })).sort).toBe("timestamp_desc");
  });

  it("a registered action filters EXACTLY (audit.go:47-49)", () => {
    expect(parseAuditFilters(new URLSearchParams({ action: "repository:create" })).action).toBe("repository:create");
    expect(parseAuditFilters(new URLSearchParams({ action: "repository:create" })).actionPrefix).toBe("");
  });

  it("a known filter prefix filters as a prefix (audit.go:50-52)", () => {
    expect(parseAuditFilters(new URLSearchParams({ action: "repository:visibility" })).actionPrefix).toBe(
      "repository:visibility",
    );
    expect(parseAuditFilters(new URLSearchParams({ action: "repository:visibility" })).action).toBe("");
    expect(parseAuditFilters(new URLSearchParams({ action: "organization:team:member" })).actionPrefix).toBe(
      "organization:team:member",
    );
  });

  it("the one-segment family root is NOT a filter; an unknown value filters NEITHER (audit.go:47-53)", () => {
    expect(parseAuditFilters(new URLSearchParams({ action: "repository" })).action).toBe("");
    expect(parseAuditFilters(new URLSearchParams({ action: "repository" })).actionPrefix).toBe("");
    expect(parseAuditFilters(new URLSearchParams({ action: "total:junk" })).action).toBe("");
    expect(parseAuditFilters(new URLSearchParams({ action: "total:junk" })).actionPrefix).toBe("");
  });

  it("the origin must be one of the filterable four (audit.go:32,54)", () => {
    expect(parseAuditFilters(new URLSearchParams({ origin: "ui" })).origin).toBe("ui");
    expect(parseAuditFilters(new URLSearchParams({ origin: "cli" })).origin).toBe("cli");
    expect(parseAuditFilters(new URLSearchParams({ origin: "junk" })).origin).toBeUndefined();
  });

  it("the actor trims (audit.go:57's FormTrim)", () => {
    expect(parseAuditFilters(new URLSearchParams({ actor: "  alice  " })).actor).toBe("alice");
  });

  it("page: junk reads as 1, max(junk,1) semantics (audit.go:86)", () => {
    expect(parseAuditFilters(new URLSearchParams({ page: "3" })).page).toBe(3);
    expect(parseAuditFilters(new URLSearchParams({ page: "abc" })).page).toBe(1);
    expect(parseAuditFilters(new URLSearchParams({ page: "0" })).page).toBe(1);
    expect(parseAuditFilters(new URLSearchParams({ page: "-5" })).page).toBe(1);
  });

  it("the sort link builder keeps every non-empty param and drops the page on page 1 (paginate.tmpl's GetParams)", () => {
    const filters = parseAuditFilters(new URLSearchParams("sort=timestamp_asc&action=repository:create&origin=api&actor=alice"));
    expect(auditPageHref("/x/settings/audit_logs", filters, 2)).toBe(
      "/x/settings/audit_logs?page=2&sort=timestamp_asc&action=repository%3Acreate&origin=api&actor=alice",
    );
    // Page 1 omits the page param (paginate.tmpl renders ?page= only for
    // the link's target page — ours carries it whenever it isn't 1).
    expect(auditPageHref("/x/settings/audit_logs", filters, 1)).toBe(
      "/x/settings/audit_logs?sort=timestamp_asc&action=repository%3Acreate&origin=api&actor=alice",
    );
  });
});

// --- the actor resolution (audit.go:57-64) --------------------------------------

describe("resolveAuditActorId (GetUserByName; the miss matches NOTHING)", () => {
  it("resolves an existing name case-insensitively", async () => {
    expect(await resolveAuditActorId(env.DB, "alice")).toBe(alice.id);
    expect(await resolveAuditActorId(env.DB, "ALICE")).toBe(alice.id);
  });

  it("the empty input filters nothing (null — upstream leaves ActorID zeroed)", async () => {
    expect(await resolveAuditActorId(env.DB, "")).toBeNull();
  });

  it("an unknown name resolves to -1 — matches nothing, never everything (audit.go:60)", async () => {
    expect(await resolveAuditActorId(env.DB, "ghost")).toBe(-1);
  });
});

// --- the loader (the shared read; scope isolation + the keyset pager) -----------

describe("loadSettingsAuditLogs — the repo scope", () => {
  it("carries the scope pair only: another repo's rows and organization rows never render", async () => {
    await seedEvent({}); // an atlas row
    await seedEvent({ scopeId: otherRepo.id, scopeName: "bob/bux" }); // the other repo
    await seedEvent({ scopeType: "organization", scopeId: String(org.id), scopeName: "acme" }); // cross-type
    const data = await loadSettingsAuditLogs(env.DB, { type: "repository", id: repo.id }, new URLSearchParams());
    // The scope's own rows: the seeded one + the slice-one create emit that
    // RepoService.create rode (its message is the registry's template).
    expect(data.events.map((row) => row.scopeId)).toEqual([repo.id, repo.id]);
    expect(data.events.some((row) => row.action === AuditActions.RepositoryCreate)).toBe(true);
    expect(data.events.every((row) => row.scopeType === "repository")).toBe(true);
  });

  it("the org scope pair isolates symmetrically (scope_type AND scope_id)", async () => {
    const data = await loadSettingsAuditLogs(
      env.DB,
      { type: "organization", id: String(org.id) },
      new URLSearchParams(),
    );
    // Only the createOrg emit — the repository events (both fixtures carry
    // create emits) never satisfy the organization scope pair.
    expect(data.events).toHaveLength(1);
    expect(data.events[0]?.action).toBe(AuditActions.OrganizationCreate);
    expect(data.events[0]?.scopeId).toBe(String(org.id));
  });

  it("an empty scope renders the empty page", async () => {
    const data = await loadSettingsAuditLogs(env.DB, REPO_SCOPE, new URLSearchParams());
    expect(data.events).toEqual([]);
    expect(data.page).toBe(1);
    expect(data.hasNext).toBe(false);
  });

  it("carries the nav's Actions flag on the repository scope only (navbar.tmpl:47's unit conditional — the hasActions threading)", async () => {
    const repoScope: AuditScopePair = { type: "repository", id: repo.id };
    const db = drizzle(env.DB);
    // b0e1d88's creation-default flip seeds the ARMED row at create
    // (DefaultRepoUnits) — drive the polarity explicitly (the wave15 idiom):
    // the disabled row reads false on both scopes.
    await db.update(repoSettings).set({ hasActions: false }).where(eq(repoSettings.repoId, repo.id));
    try {
      expect((await loadSettingsAuditLogs(env.DB, repoScope, new URLSearchParams())).hasActions).toBe(false);
      expect(
        (await loadSettingsAuditLogs(env.DB, { type: "organization", id: String(org.id) }, new URLSearchParams())).hasActions,
      ).toBe(false);
      // The armed repo row lights the repo scope; the org scope stays false
      // (its navbar carries no Actions block).
      await db.update(repoSettings).set({ hasActions: true }).where(eq(repoSettings.repoId, repo.id));
      expect((await loadSettingsAuditLogs(env.DB, repoScope, new URLSearchParams())).hasActions).toBe(true);
      expect(
        (await loadSettingsAuditLogs(env.DB, { type: "organization", id: String(org.id) }, new URLSearchParams())).hasActions,
      ).toBe(false);
    } finally {
      // Restore the creation-default armed posture for later tests in the file.
      await db.update(repoSettings).set({ hasActions: true }).where(eq(repoSettings.repoId, repo.id));
    }
  });

  it("the keyset walk forward: page 1 (newest 25), page 2 (the disjoint next 25), page 3 (the short tail)", async () => {
    for (let i = 1; i <= 55; i++) {
      await seedEvent({ timestamp: new Date(TS0.getTime() + i * 1000), origin: "ui", vars: { scope: "x", visibility: String(i) } });
    }
    const scope = { type: "repository" as const, id: repo.id };
    const page1 = await loadSettingsAuditLogs(env.DB, scope, new URLSearchParams({ page: "1" }));
    expect(page1.page).toBe(1);
    expect(page1.events).toHaveLength(AUDIT_PAGE_SIZE);
    expect(page1.hasNext).toBe(true);
    // Page 1 = the create emit (the wall-clock newest) + the 24 newest seeds.
    expect(page1.events[0]?.action).toBe(AuditActions.RepositoryCreate);
    expect(page1.events[1]?.origin).toBe("ui");

    const page2 = await loadSettingsAuditLogs(env.DB, scope, new URLSearchParams({ page: "2" }));
    expect(page2.page).toBe(2);
    expect(page2.events).toHaveLength(AUDIT_PAGE_SIZE);
    expect(page2.hasNext).toBe(true);
    // Disjoint pages: no row repeats across the keyset boundary.
    const p1Set = new Set(page1.events.map((row) => row.id));
    for (const row of page2.events) expect(p1Set.has(row.id)).toBe(false);

    const page3 = await loadSettingsAuditLogs(env.DB, scope, new URLSearchParams({ page: "3" }));
    expect(page3.page).toBe(3);
    expect(page3.events).toHaveLength(6); // 56 rows total = 25 + 25 + 6
    expect(page3.hasNext).toBe(false);
    const p2Set = new Set(page2.events.map((row) => row.id));
    for (const row of page3.events) expect(p2Set.has(row.id)).toBe(false);
  });

  it("a requested page beyond the data clamps to the last non-empty page (paginator.go:52)", async () => {
    for (let i = 1; i <= 30; i++) {
      await seedEvent({ timestamp: new Date(TS0.getTime() + i * 1000) });
    }
    const scope = { type: "repository" as const, id: repo.id };
    const data = await loadSettingsAuditLogs(env.DB, scope, new URLSearchParams({ page: "99" }));
    expect(data.page).toBe(2); // 31 rows = 25 + 6 — the short page IS the last
    expect(data.events).toHaveLength(6);
    expect(data.hasNext).toBe(false);
  });

  it("an exact-multiple boundary steps back to the last full page (the empty-boundary clamp)", async () => {
    for (let i = 1; i <= 24; i++) {
      await seedEvent({ timestamp: new Date(TS0.getTime() + i * 1000) });
    }
    const scope = { type: "repository" as const, id: repo.id };
    // 25 rows total (the create emit + 24 seeds): page 2 is the empty
    // boundary — the clamp answers page 1.
    const data = await loadSettingsAuditLogs(env.DB, scope, new URLSearchParams({ page: "2" }));
    expect(data.page).toBe(1);
    expect(data.events).toHaveLength(25);
    expect(data.hasNext).toBe(false);
  });

  it("an exactly-full second page probes empty and stays (50-row scope, page 2 of the org scope)", async () => {
    for (let i = 1; i <= 49; i++) {
      await emitAudit(drizzle(env.DB), {
        action: AuditActions.OrganizationMemberAdd,
        actorId: alice.id,
        actorName: alice.username,
        scopeType: "organization",
        scopeId: String(org.id),
        scopeName: "acme",
        origin: "ui",
        vars: { member: `user-${i}`, scope: "acme" },
        timestamp: new Date(TS0.getTime() + i * 1000),
      });
    }
    const data = await loadSettingsAuditLogs(
      env.DB,
      { type: "organization", id: String(org.id) },
      new URLSearchParams({ page: "2" }),
    );
    // 50 rows total (createOrg's emit + 49): page 2 is exactly full, the
    // one-row probe finds nothing → hasNext false, no pager.
    expect(data.page).toBe(2);
    expect(data.events).toHaveLength(25);
    expect(data.hasNext).toBe(false);
  });

  it("the actor filter spans the impersonation (actor OR impersonator, audit_event.go:182-184)", async () => {
    await seedEvent({}); // alice acted
    await seedEvent({
      action: AuditActions.RepositoryArchive,
      actorId: alice.id,
      impersonatorId: morgan.id,
      impersonatorName: morgan.username,
      vars: { scope: `${alice.username}/${repo.slug}` },
    });
    await seedEvent({ actorId: bob.id, actorName: bob.username }); // neither
    const morgans = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ actor: "morgan" }),
    );
    expect(morgans.events).toHaveLength(1); // only the impersonated row
    expect(morgans.events[0]?.impersonatorId).toBe(morgan.id);
    const alices = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ actor: "alice" }),
    );
    // Her trail: the slice-one create emit (actor = the owner), her seeded
    // row, AND the impersonated row (the OR arm) — three.
    expect(alices.events).toHaveLength(3);
    const ghosts = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ actor: "ghost" }),
    );
    expect(ghosts.events).toEqual([]); // the -1 arm matches nothing
  });

  it("the action filters: exact, family prefix, and the non-filter root", async () => {
    await seedEvent({}); // repository:visibility:update (the default action)
    const exact = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ action: AuditActions.RepositoryVisibility }),
    );
    expect(exact.events).toHaveLength(1);
    const prefix = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ action: "repository:visibility" }),
    );
    expect(prefix.events).toHaveLength(1); // the prefix arm matches the same row
    const root = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ action: "repository" }),
    );
    expect(root.events).toHaveLength(2); // NOT a filter — everything renders
  });

  it("the origin filter and the ascending sort", async () => {
    await seedEvent({ origin: "ui", timestamp: new Date(TS0.getTime() + 1000) });
    await seedEvent({
      origin: "api",
      action: AuditActions.RepositoryArchive,
      vars: { scope: `${alice.username}/${repo.slug}` },
      timestamp: new Date(TS0.getTime() + 2000),
    });
    const ui = await loadSettingsAuditLogs(env.DB, { type: "repository", id: repo.id }, new URLSearchParams({ origin: "ui" }));
    expect(ui.events).toHaveLength(1);
    expect(ui.events[0]?.origin).toBe("ui");
    // Ascending: the pinned oldest seed first (the create emit's wall-clock
    // stamp is the newest of the three).
    const asc = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ sort: "timestamp_asc" }),
    );
    expect(asc.events).toHaveLength(3);
    expect(asc.events[0]?.origin).toBe("ui");
    expect(asc.events[0]?.createdUnix.getTime()).toBe(TS0.getTime() + 1000);
  });
});

describe("loadSettingsAuditLogs — the walk bound (AUDIT_PAGE_WALK_MAX)", () => {
  it("a request beyond the bound clamps to page 50 with the Next arm dark", async () => {
    // 1250 rows + the create emit in the OTHER repo's scope — 50+ pages of
    // 25. The rows ride auditEventInsert in chunked batches (the seam's
    // transactional form; never raw SQL). The chunk array carries the
    // family's BatchItem tuple cast (org-teams/blocks convention — drizzle's
    // batch signature wants the head-carried tuple).
    const d1 = drizzle(env.DB);
    let batch: BatchItem<"sqlite">[] = [];
    for (let i = 1; i <= 1250; i++) {
      batch.push(
        auditEventInsert(d1, {
          action: AuditActions.RepositoryVisibility,
          actorId: bob.id,
          actorName: bob.username,
          scopeType: "repository",
          scopeId: otherRepo.id,
          scopeName: `bob/${otherRepo.slug}`,
          origin: "system",
          vars: { scope: `bob/${otherRepo.slug}`, visibility: String(i) },
          timestamp: new Date(TS0.getTime() + i * 1000),
        }),
      );
      if (batch.length === 50) {
        await d1.batch(batch as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
        batch = [];
      }
    }
    if (batch.length > 0) await d1.batch(batch as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    const data = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: otherRepo.id },
      new URLSearchParams({ page: "999" }),
    );
    expect(data.page).toBe(AUDIT_PAGE_WALK_MAX);
    expect(data.events).toHaveLength(AUDIT_PAGE_SIZE);
    // At the bound the probe is suppressed: Next renders disabled even
    // though more rows exist (the module header's clamp note).
    expect(data.hasNext).toBe(false);
  });
});

// --- the DOM (repo/settings/audit_logs.tmpl + org twin × shared/audit/list) -----

describe("the repo audit page DOM (repo/settings/audit_logs.tmpl × shared/audit/list.tmpl)", () => {
  async function renderRepo(query = new URLSearchParams()): Promise<string> {
    const data = await loadSettingsAuditLogs(env.DB, { type: "repository", id: repo.id }, query);
    return renderToString(<RepoSettingsAuditLogsPage ctx={ctx} data={data} />);
  }

  it("renders the full document with the upstream pageClass and the h4", async () => {
    const html = await renderRepo();
    expect(html).toContain("repository settings");
    expect(html).toContain(`<h4 class="ui top attached header">${settingsAuditLogsLocale.title}</h4>`);
    expect(html).toContain('class="repo-setting-content"');
    // The full-document render path agrees.
    const data = await loadSettingsAuditLogs(env.DB, { type: "repository", id: repo.id }, new URLSearchParams());
    expect(renderRepoSettingsAuditLogsPage({ ctx, data })).toContain("repo-setting-content");
  });

  it("renders the filter form: the hidden sort carrier, the actor input, both selects", async () => {
    const html = await renderRepo();
    // hono/jsx self-closes void elements (the render's XHTML style).
    expect(html).toContain('<input type="hidden" name="sort" value="timestamp_desc"/>');
    expect(html).toContain('name="actor"');
    expect(html).toContain(`placeholder="${settingsAuditLogsLocale.filter_actor}"`);
    expect(html).toContain(`>${settingsAuditLogsLocale.filter_action}</option>`);
    expect(html).toContain(`>${settingsAuditLogsLocale.filter_origin}</option>`);
    expect(html).toContain('<option value="ui">ui</option>');
    expect(html).toContain('aria-label="Search…"');
    expect(html).toContain('name="action"');
    expect(html).toContain('name="origin"');
  });

  it("marks the applied filters on the form (the select's selected arm + the kept actor)", async () => {
    const html = await renderRepo(new URLSearchParams({ action: "repository:create", actor: "alice" }));
    expect(html).toContain('<option selected="" value="repository:create">');
    expect(html).toContain('value="alice"');
  });

  it("renders the upstream table shape with the scoped-th a11y convention", async () => {
    const html = await renderRepo();
    expect(html).toContain('<table class="ui very basic striped table unstackable">');
    for (const label of [
      settingsAuditLogsLocale.actor,
      settingsAuditLogsLocale.scope,
      settingsAuditLogsLocale.action,
      settingsAuditLogsLocale.origin,
      settingsAuditLogsLocale.details,
      settingsAuditLogsLocale.ip_address,
    ]) {
      expect(html).toContain(`<th scope="col">${label}</th>`);
    }
    // The timestamp th carries the upstream data-sortt attrs before its
    // (linked) label — asserted in its own shape.
    expect(html).toContain('<th scope="col" data-sortt-asc="timestamp_asc" data-sortt-desc="timestamp_desc">');
    expect(html).toContain(`>${settingsAuditLogsLocale.timestamp}`);
    expect(html).toContain('data-sortt-asc="timestamp_asc"');
    expect(html).toContain('data-sortt-desc="timestamp_desc"');
  });

  it("renders the row anatomy: the create emit's message, links, code cells, IP, the FullTime stamp", async () => {
    await seedEvent({
      action: AuditActions.RepositoryArchive,
      impersonatorId: morgan.id,
      impersonatorName: morgan.username,
      actorCredential: "access-token:7",
      vars: { scope: `${alice.username}/${repo.slug}` },
    });
    const html = await renderRepo();
    // The slice-one create emit's RENDERED message (the seam rendered at
    // emit time — the page shows stored text).
    expect(html).toContain(`Created repository ${alice.username}/${repo.slug}.`);
    expect(html).toContain(`href="/${morgan.username}">${morgan.username}</a>`);
    expect(html).toContain(`<span class="text small"> ${settingsAuditLogsLocale.impersonating_as}</span>`);
    expect(html).toContain(`<code class="text small">access-token:7</code>`);
    expect(html).toContain(`href="/${alice.username}/${repo.slug}">`);
    expect(html).toContain("<code>repository:archive</code>");
    expect(html).toContain("<code>ui</code>");
    expect(html).toContain("<td>203.0.113.7</td>");
    // The FullTime stamp (the admin-monitor twin of DateUtils.FullTime).
    const rows = await loadSettingsAuditLogs(env.DB, { type: "repository", id: repo.id }, new URLSearchParams());
    const newest = rows.events[0];
    if (newest === undefined) throw new Error("fixture rows missing");
    expect(html).toContain(formatMonitorFullTime(newest.createdUnix));
  });

  it("renders the deleted arms: an empty actor snapshot reads (removed); a null scope name reads the deleted-type text", async () => {
    await seedEvent({ actorName: "", actorCredential: null, scopeName: null });
    const html = await renderRepo();
    expect(html).toContain(`<span class="text small">${settingsAuditLogsLocale.deleted_actor}</span>`);
    expect(html).toContain(`(removed repository with ID ${repo.id})`);
  });

  it("renders the empty arm (colspan 7) when the filter matches nothing", async () => {
    // The ghost-actor filter is the never-matching arm (-1): a row-bearing
    // scope renders the empty state under it (list.tmpl:84).
    const data = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ actor: "ghost" }),
    );
    const html = renderToString(<RepoSettingsAuditLogsPage ctx={ctx} data={data} />);
    expect(html).toContain(`<td colspan="${7}">${settingsAuditLogsLocale.no_events}</td>`);
  });

  it("the sort header links toggle the direction keeping the page; the arrow follows sortArrow's arms", async () => {
    for (let i = 1; i <= 26; i++) {
      await seedEvent({ timestamp: new Date(TS0.getTime() + i * 1000) });
    }
    const plain = await renderRepo();
    // No explicit ?sort → no arrow glyph in the TABLE HEADER (util_misc.go:
    // 31-33) — scoped because the page HEADER's Watch dropdown now carries
    // its own triangle-down caret (the B-4 trio), which the whole-page
    // negative would wrongly trip on.
    const plainHead = plain.slice(plain.indexOf("<thead>"), plain.indexOf("</thead>"));
    expect(plainHead).not.toContain("octicon-triangle-up");
    expect(plainHead).not.toContain("octicon-triangle-down");
    expect(plain).toContain('href="/alice/atlas/settings/audit_logs?sort=timestamp_asc">');
    const asc = await renderRepo(new URLSearchParams({ sort: "timestamp_asc" }));
    expect(asc).toContain("octicon-triangle-up");
    expect(asc).toContain('href="/alice/atlas/settings/audit_logs?sort=timestamp_desc">');
    const desc = await renderRepo(new URLSearchParams({ sort: "timestamp_desc" }));
    expect(desc).toContain("octicon-triangle-down");
  });

  it("the pager renders paginate.tmpl's unlimited shape across the keyset pages", async () => {
    for (let i = 1; i <= 26; i++) {
      await seedEvent({ timestamp: new Date(TS0.getTime() + i * 1000) });
    }
    // Page 1 of 27 rows: Previous disabled, Next onto page 2 (hono escapes
    // the query's & as &amp; inside the attribute).
    const page1 = await renderRepo();
    expect(page1).toContain('<a class="disabled item navigation"');
    expect(page1).toContain(`href="/alice/atlas/settings/audit_logs?page=2&amp;sort=timestamp_desc"`);
    expect(page1).toContain(`>${settingsAuditLogsLocale.previous}</span>`);
    expect(page1).toContain(`>${settingsAuditLogsLocale.next}</span>`);
    expect(page1).toContain('class="item">1</a>');
    // Page 2 (the short tail): Next disabled, Previous onto page 1 (the
    // page param drops at page 1 — GetParams keeps only page's target).
    const data2 = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ page: "2" }),
    );
    const page2 = renderToString(<RepoSettingsAuditLogsPage ctx={ctx} data={data2} />);
    expect(page2).toContain('href="/alice/atlas/settings/audit_logs?sort=timestamp_desc"');
    expect(page2).toContain('class="disabled item navigation"');
    expect(page2).toContain('class="item">2</a>');
    // A collapsed pager renders NO pager at all (paginator.go:67-72) — the
    // never-matching ghost filter is the single-page arm on this seeded
    // scope.
    const data1 = await loadSettingsAuditLogs(
      env.DB,
      { type: "repository", id: repo.id },
      new URLSearchParams({ actor: "ghost" }),
    );
    const onePage = renderToString(<RepoSettingsAuditLogsPage ctx={ctx} data={data1} />);
    expect(onePage).not.toContain("pagination menu");
  });

  it("throws without a resolved repo (the settings pages' ctx.repo contract)", async () => {
    const data = await loadSettingsAuditLogs(env.DB, { type: "repository", id: repo.id }, new URLSearchParams());
    expect(() => renderToString(<RepoSettingsAuditLogsPage ctx={{ ...ctx, repo: undefined }} data={data} />)).toThrow(
      "RepoSettingsAuditLogsPage requires ctx.repo",
    );
  });
});

describe("the org audit page DOM (org/settings/audit_logs.tmpl)", () => {
  it("renders the full document with the org pageClass, the h4, and the active navbar item LAST", async () => {
    const data = await loadSettingsAuditLogs(env.DB, { type: "organization", id: String(org.id) }, new URLSearchParams());
    const html = renderToString(<OrgSettingsAuditLogsPage ctx={ctx} org={org} data={data} />);
    expect(html).toContain("organization settings");
    expect(html).toContain(`<h4 class="ui top attached header">${settingsAuditLogsLocale.title}</h4>`);
    expect(html).toContain('class="org-setting-content"');
    // The navbar item lights up in upstream's LAST position (org navbar
    // .tmpl:50-52 — after the Actions details, the menu's final anchor; the
    // order itself is the shared navbar suite's assertHrefOrder pin).
    expect(html).toContain('class="active item" href="/acme/settings/audit_logs"');
    const at = (s: string) => html.indexOf(s);
    expect(at('href="/acme/settings/audit_logs"')).toBeGreaterThan(at('href="/acme/settings/actions/variables"'));
    expect(html.lastIndexOf('href="/acme/settings/audit_logs"')).toBe(at('href="/acme/settings/audit_logs"')); // exactly one
    // The full-document render path agrees.
    expect(renderOrgSettingsAuditLogsPage({ ctx, org, data })).toContain('href="/acme/settings/audit_logs"');
    // The org page shows the org's own emit (the createOrg instrumentation).
    expect(html).toContain("Created organization acme.");
  });
});

// --- the mounted-route harness (the org-settings-applications matrix pattern) ----

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

async function ownerSessionHeader(): Promise<string> {
  if (viewer.kind !== "user") throw new Error("fixture viewer missing");
  return sessionHeader(viewer.id);
}

const repoPagePath = (): string => `/${alice.username}/${repo.slug}/settings/audit_logs`;
const orgPagePath = (): string => `/${org.username}/settings/audit_logs`;

describe("the mounted repo route (GET /{owner}/{repo}/settings/audit_logs — the settingsGate posture)", () => {
  it("303s an anonymous GET onto the login round-trip", async () => {
    const res = await fetchUi(repoPagePath());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(repoPagePath())}`);
  });

  it("404-shells a signed-in non-admin's GET (equally undiscoverable, the tags-page siblings' posture)", async () => {
    const res = await fetchUi(repoPagePath(), { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain("repo-setting-content");
  });

  it("renders the admin owner's GET at 200 with the active navbar item and the scope's rows", async () => {
    const res = await fetchUi(repoPagePath(), { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository settings");
    expect(html).toContain(`class="active item" href="${repoPagePath()}"`);
    expect(html).toContain(`Created repository ${alice.username}/${repo.slug}.`);
    expect(html).not.toContain("bob/bux"); // the isolation fixture never leaks
  });

  it("carries the filters through the route (?action= narrows, the form re-renders it selected)", async () => {
    await seedEvent({}); // a visibility row (not a create)
    const res = await fetchUi(`${repoPagePath()}?action=${encodeURIComponent("repository:create")}`, {
      headers: { cookie: await ownerSessionHeader() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<option selected="" value="repository:create">');
    expect(html).not.toContain("Changed visibility"); // the filtered-out row
  });

  it("answers the POST with chi's 405 (the GET-only page)", async () => {
    const res = await fetchUi(repoPagePath(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await ownerSessionHeader() },
      body: new URLSearchParams({ sort: "timestamp_asc" }).toString(),
    });
    expect(res.status).toBe(405);
  });
});

describe("the mounted org route (GET /{org}/settings/audit_logs — the require-owner prologue)", () => {
  it("303s an anonymous GET onto the login round-trip", async () => {
    const res = await fetchUi(orgPagePath());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(orgPagePath())}`);
  });

  it("404-shells a member non-owner's GET (the RequireOwner posture)", async () => {
    await drizzle(env.DB)
      .insert(orgMembers)
      .values({ orgId: org.id, userId: bob.id, role: "member", createdAt: TS0 })
      .run();
    const res = await fetchUi(orgPagePath(), { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain("org-setting-content");
  });

  it("renders the owner's GET at 200 with the active navbar item and the org-scope rows only", async () => {
    const res = await fetchUi(orgPagePath(), { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("organization settings");
    expect(html).toContain(`class="active item" href="${orgPagePath()}"`);
    expect(html).toContain("Created organization acme.");
    expect(html).not.toContain("alice/atlas"); // repository events never leak
  });

  it("carries the keyset pager through the route (page 2's Previous targets page 1)", async () => {
    for (let i = 1; i <= 26; i++) {
      await emitAudit(drizzle(env.DB), {
        action: AuditActions.OrganizationMemberAdd,
        actorId: alice.id,
        actorName: alice.username,
        scopeType: "organization",
        scopeId: String(org.id),
        scopeName: org.username,
        origin: "ui",
        vars: { member: `user-${i}`, scope: org.username },
        timestamp: new Date(TS0.getTime() + i * 1000),
      });
    }
    const page2 = await fetchUi(`${orgPagePath()}?page=2`, { headers: { cookie: await ownerSessionHeader() } });
    expect(page2.status).toBe(200);
    const html = await page2.text();
    expect(html).toContain(`href="${orgPagePath()}?sort=timestamp_desc"`);
    expect(html).toContain('class="item">2</a>');
    expect(html).toContain(`Added user user-1 to organization ${org.username}.`); // the oldest seeded row
  });

  it("answers the POST with chi's 405 (the GET-only page)", async () => {
    const res = await fetchUi(orgPagePath(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await ownerSessionHeader() },
      body: new URLSearchParams({ sort: "timestamp_asc" }).toString(),
    });
    expect(res.status).toBe(405);
  });
});

// --- the route claim pins (parse ↔ registration — the applications-matrix pin) ---

describe("the route claim pins (the settings families claim exactly the audit arms)", () => {
  it("parses both shapes; misspellings and deeper tails stay unclaimed", () => {
    expect(parseUiRoute(repoPagePath())).toEqual({
      family: "settings-audit-logs",
      owner: alice.username,
      repo: repo.slug,
    });
    expect(parseUiRoute(orgPagePath())).toEqual({ family: "org-settings-audit-logs", owner: org.username });
    expect(handlesUiRoute(repoPagePath())).toBe(true);
    expect(handlesUiRoute(orgPagePath())).toBe(true);
    // The singular misspelling, deeper tails, and query-less junk.
    expect(parseUiRoute(`/${alice.username}/${repo.slug}/settings/audit_log`)).toBeNull();
    expect(parseUiRoute(`/${alice.username}/${repo.slug}/settings/audit_logs/extra`)).toBeNull();
    expect(parseUiRoute(`/${org.username}/settings/audit_logs/extra`)).toBeNull();
    expect(handlesUiRoute(`/${org.username}/settings/audit_logs/extra`)).toBe(false);
  });
});
