/**
 * The admin AUDIT LOG page's tests (census B-70 — GET
 * /-/admin/monitor/audit_logs + GET /-/admin/monitor/audit_logs/export at
 * ui/index.ts over pages/admin-audit-logs.tsx, the settings-audit-logs
 * shared renderer at the ADMIN arm): the instance-wide stream (the loader's
 * undefined scope lists EVERY event — upstream's empty-ScopeType arm), the
 * admin/audit/list.tmpl DOM (pageClass, the flex-left-right h4 + export
 * button, the shared list, the folded nav's first monitor item), the export
 * arm (the mirrored filters with the sort forced ascending, the NDJSON
 * eventJSON projection with its omitempty arms, the attachment filename),
 * the admin-gate route matrix (anonymous 303 / non-admin 404 shell / admin
 * 200; GET-only 405s), and the route claim pins. Audit rows seed ONLY
 * through the landed emit seam — never raw SQL.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { AuditActions, emitAudit, type AuditEventInput } from "../../services/audit";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import {
  ADMIN_AUDIT_LOGS_PAGE_LINK,
  adminAuditExportHref,
  adminAuditLogExportFilename,
  adminAuditLogsLocale,
  auditEventAsJsonLine,
  renderAdminAuditLogsPage,
} from "./admin-audit-logs";
import { loadSettingsAuditLogs, settingsAuditLogsLocale } from "./settings-audit-logs";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const TS0 = new Date("2026-06-01T00:00:00Z");

let ctx: UiContext;

interface Principal {
  id: number;
  username: string;
}

async function seedPrincipal(username: string, isAdmin: boolean): Promise<Principal> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), isAdmin, createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("principal seed failed");
  return { id: user.id, username: user.username };
}

let root: Principal; // the admin
let peon: Principal; // the signed-in non-admin
let org: OrgRecord;
let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["audit_event", "repo_counters", "team_members", "teams", "org_members", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  root = await seedPrincipal("root", true);
  peon = await seedPrincipal("peon", false);
  ctx = { viewer: { kind: "user", id: root.id, username: root.username, isAdmin: true }, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };
  org = await new OrgService(env.DB).createOrg({ name: "acme", ownerId: peon.id, visibility: "public", now: TS0 });
  repo = await new RepoService(env.DB).create({ owner: { id: peon.id, usernameLower: peon.username }, name: "atlas", isPrivate: false });
});

/** Seed one audit row through the landed emit seam; defaults shape a
 *  repository-scope row. */
async function seedEvent(over: Partial<AuditEventInput>): Promise<void> {
  await emitAudit(drizzle(env.DB), {
    action: AuditActions.RepositoryVisibility,
    actorId: peon.id,
    actorName: peon.username,
    scopeType: "repository",
    scopeId: repo.id,
    scopeName: `${peon.username}/${repo.slug}`,
    origin: "ui",
    ipAddress: "203.0.113.7",
    vars: { scope: `${peon.username}/${repo.slug}`, visibility: "private" },
    ...over,
  });
}

// --- the instance-wide stream (the loader's admin arm) -------------------------

describe("loadSettingsAuditLogs — the admin arm (scope undefined lists EVERY event)", () => {
  it("renders repository AND organization rows together (the empty-ScopeType arm, shared/audit/audit.go:21-30)", async () => {
    await seedEvent({});
    await seedEvent({
      action: AuditActions.OrganizationDelete,
      scopeType: "organization",
      scopeId: String(org.id),
      scopeName: "acme",
      vars: { scope: "acme" },
    });
    const data = await loadSettingsAuditLogs(env.DB, undefined, new URLSearchParams());
    // The two seeded rows + the create emits of both fixtures (the
    // instrumentation rode them) — no scope pair narrows the query.
    expect(data.events.some((row) => row.scopeType === "repository")).toBe(true);
    expect(data.events.some((row) => row.scopeType === "organization")).toBe(true);
    expect(data.events.some((row) => row.action === AuditActions.OrganizationDelete)).toBe(true);
    expect(data.events.some((row) => row.action === AuditActions.OrganizationCreate)).toBe(true);
  });

  it("carries hasActions false (no repo row is read on the admin arm)", async () => {
    await seedEvent({});
    const data = await loadSettingsAuditLogs(env.DB, undefined, new URLSearchParams());
    expect(data.hasActions).toBe(false);
  });
});

// --- the page DOM (admin/audit/list.tmpl) --------------------------------------

describe("the admin audit page DOM (admin/audit/list.tmpl)", () => {
  it("renders the admin-monitor layout, the flex-left-right h4 with the export button, and the shared list", async () => {
    await seedEvent({});
    const data = await loadSettingsAuditLogs(env.DB, undefined, new URLSearchParams());
    const html = renderAdminAuditLogsPage({ ctx, data, query: new URLSearchParams() });
    expect(html).toContain("admin monitor");
    expect(html).toContain('class="admin-setting-content"');
    expect(html).toContain('<h4 class="ui top attached header flex-left-right">');
    expect(html).toContain(`<span>${settingsAuditLogsLocale.title}</span>`);
    // The export button: the primary small anchor with the download glyph and
    // the PIN's JSONL label — a BARE first visit links the BARE export URL
    // (upstream's `{{if $.Page.GetParams}}?{{...}}{{end}}`).
    expect(html).toContain(`<a class="ui primary small button" href="${ADMIN_AUDIT_LOGS_PAGE_LINK}/export">`);
    expect(html).toContain(adminAuditLogsLocale.export);
    expect(html).toContain("octicon-download");
    // The shared list renders (the instance-wide row among them).
    expect(html).toContain(`Created repository ${peon.username}/${repo.slug}.`);
    // The audit.disabled banner renders never (the seam records
    // unconditionally — the module header's reduction).
    expect(html).not.toContain("Audit event recording is disabled");
  });

  it("lights the folded nav's audit item FIRST in the monitor menu (navbar.tmpl:110-112) with the group open", async () => {
    const data = await loadSettingsAuditLogs(env.DB, undefined, new URLSearchParams());
    const html = renderAdminAuditLogsPage({ ctx, data, query: new URLSearchParams() });
    expect(html).toContain('class="active item" href="/-/admin/monitor/audit_logs"');
    expect(html).toContain(`>${settingsAuditLogsLocale.title}</a>`);
    const at = (s: string) => html.indexOf(s);
    // FIRST in the menu — before stats, inside the open Monitoring details.
    expect(at('href="/-/admin/monitor/audit_logs"')).toBeGreaterThan(-1);
    expect(at('href="/-/admin/monitor/audit_logs"')).toBeLessThan(at('href="/-/admin/monitor/stats"'));
    expect(html).toContain('<details class="item" open="">'); // some group open
    expect(html).toContain(`>${settingsAuditLogsLocale.title}</a>`); // the label is audit.title
  });

  it("mirrors the request's filters onto the export href minus page (GetParams; '?' only when a param survives)", () => {
    expect(adminAuditExportHref(`${ADMIN_AUDIT_LOGS_PAGE_LINK}/export`, new URLSearchParams())).toBe(
      `${ADMIN_AUDIT_LOGS_PAGE_LINK}/export`,
    );
    const filtered = new URLSearchParams("page=2&sort=timestamp_asc&action=repository:create&origin=api&actor=peon");
    expect(adminAuditExportHref(`${ADMIN_AUDIT_LOGS_PAGE_LINK}/export`, filtered)).toBe(
      `${ADMIN_AUDIT_LOGS_PAGE_LINK}/export?sort=timestamp_asc&action=${encodeURIComponent("repository:create")}&origin=api&actor=peon`,
    );
    // An UNKNOWN action value still rides (raw params, not the parsed set).
    const junk = new URLSearchParams("action=total:junk&page=3");
    expect(adminAuditExportHref(`${ADMIN_AUDIT_LOGS_PAGE_LINK}/export`, junk)).toBe(
      `${ADMIN_AUDIT_LOGS_PAGE_LINK}/export?action=${encodeURIComponent("total:junk")}`,
    );
  });
});

// --- the export arm (ExportAuditLogs) ------------------------------------------

describe("the export arm (audit.go:28-71)", () => {
  it("names the file Go-exactly (20060102-150405Z over UTC)", () => {
    expect(adminAuditLogExportFilename(new Date("2026-06-01T02:03:04Z"))).toBe("gitea-audit-log-20260601-020304Z.jsonl");
  });

  it("projects the eventJSON shape in Go's field order with the omitempty arms", () => {
    const line = auditEventAsJsonLine({
      id: 7,
      action: "repository:visibility:update",
      actorId: 3,
      actorName: "peon",
      actorCredential: "access-token:7",
      impersonatorId: 0,
      impersonatorName: null,
      scopeType: "repository",
      scopeId: "00000000-0000-4000-8000-00000000abcd",
      scopeName: "peon/atlas",
      origin: "ui",
      message: "Changed visibility of repository peon/atlas to private.",
      metadata: null,
      ipAddress: "203.0.113.7",
      createdUnix: new Date("2026-06-01T00:01:40Z"),
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    // Field ORDER (Go's eventJSON struct order) + the omitempty arms.
    expect(Object.keys(parsed)).toEqual([
      "action",
      "actor",
      "actor_credential",
      "scope",
      "message",
      "time",
      "ip_address",
      "origin",
    ]);
    expect(parsed.actor).toEqual({ type: "user", id: 3, name: "peon" }); // NUMERIC id
    expect(parsed.actor_credential).toBe("access-token:7");
    expect(parsed.scope).toEqual({ type: "repository", id: "00000000-0000-4000-8000-00000000abcd", name: "peon/atlas" });
    expect(parsed.time).toBe("2026-06-01T00:01:40Z"); // the whole-second arm drops the fraction
    expect(parsed.ip_address).toBe("203.0.113.7");
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain("impersonator"); // the omitempty arm
    expect(line).not.toContain('"metadata"');
  });

  it("carries the impersonator arm and the null-ip arm; a system scope omits its empty id", () => {
    const line = JSON.parse(
      auditEventAsJsonLine({
        id: 8,
        action: "organization:delete",
        actorId: 0,
        actorName: "",
        actorCredential: null,
        impersonatorId: 9,
        impersonatorName: "root",
        scopeType: "system",
        scopeId: "",
        scopeName: null,
        origin: "system",
        message: "Deleted organization acme.",
        metadata: null,
        ipAddress: null,
        createdUnix: new Date("2026-06-01T00:01:40.500Z"),
      }),
    ) as Record<string, unknown>;
    expect(line.impersonator).toEqual({ type: "user", id: 9, name: "root" });
    expect(line.actor).toEqual({ type: "user" }); // both omitempty arms closed
    expect(line.scope).toEqual({ type: "system" }); // the empty id omitted
    expect(line.ip_address).toBe(""); // upstream carries the empty string
    expect(line.time).toBe("2026-06-01T00:01:40.500Z"); // sub-second keeps ms
    expect(Object.keys(line)).toEqual([
      "action",
      "actor",
      "impersonator",
      "scope",
      "message",
      "time",
      "ip_address",
      "origin",
    ]);
  });
});

// --- the mounted-route harness (the settings-audit-logs matrix pattern) --------

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

const PAGE_PATH = "/-/admin/monitor/audit_logs";
const EXPORT_PATH = "/-/admin/monitor/audit_logs/export";

describe("the mounted page route (GET /-/admin/monitor/audit_logs — the admin ladder)", () => {
  it("303s an anonymous GET onto the login round-trip", async () => {
    const res = await fetchUi(PAGE_PATH);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(PAGE_PATH)}`);
  });

  it("404-shells a signed-in non-admin's GET (web.go:779's AdminRequired)", async () => {
    const res = await fetchUi(PAGE_PATH, { headers: { cookie: await sessionHeader(peon.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain("admin-setting-content");
  });

  it("renders the admin's GET at 200 with the export button and every scope's rows", async () => {
    await seedEvent({});
    const res = await fetchUi(PAGE_PATH, { headers: { cookie: await sessionHeader(root.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("admin monitor");
    expect(html).toContain(`href="${EXPORT_PATH}"`);
    expect(html).toContain(`Created repository ${peon.username}/${repo.slug}.`);
    expect(html).toContain("Created organization acme.");
  });

  it("carries the filters through the route (?actor= narrows the instance-wide stream)", async () => {
    await seedEvent({});
    await seedEvent({ action: AuditActions.OrganizationDelete, actorId: root.id, actorName: root.username, scopeType: "organization", scopeId: String(org.id), scopeName: "acme", vars: { scope: "acme" } });
    const res = await fetchUi(`${PAGE_PATH}?actor=${encodeURIComponent(root.username)}`, {
      headers: { cookie: await sessionHeader(root.id) },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Deleted organization acme.");
    expect(html).not.toContain("Changed visibility"); // peon's row filtered out
  });

  it("answers the POST with chi's 405 (the GET-only page)", async () => {
    const res = await fetchUi(PAGE_PATH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await sessionHeader(root.id) },
      body: new URLSearchParams({ sort: "timestamp_asc" }).toString(),
    });
    expect(res.status).toBe(405);
  });
});

describe("the mounted export route (GET /-/admin/monitor/audit_logs/export)", () => {
  it("gates like the page (anonymous 303, non-admin 404) and answers the POST with chi's 405", async () => {
    const anon = await fetchUi(EXPORT_PATH);
    expect(anon.status).toBe(303);
    const peonRes = await fetchUi(EXPORT_PATH, { headers: { cookie: await sessionHeader(peon.id) } });
    expect(peonRes.status).toBe(404);
    const post = await fetchUi(EXPORT_PATH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await sessionHeader(root.id) },
      body: "",
    });
    expect(post.status).toBe(405);
  });

  it("streams NDJSON with the mirrored filters, ascending, and the attachment headers", async () => {
    // Newest first in time — the ASC sort must invert them on the wire.
    await seedEvent({ timestamp: new Date(TS0.getTime() + 2000), ipAddress: "203.0.113.9" });
    await seedEvent({
      action: AuditActions.OrganizationDelete,
      scopeType: "organization",
      scopeId: String(org.id),
      scopeName: "acme",
      vars: { scope: "acme" },
      timestamp: new Date(TS0.getTime() + 1000),
    });
    const res = await fetchUi(`${EXPORT_PATH}?action=${encodeURIComponent(AuditActions.OrganizationDelete)}`, {
      headers: { cookie: await sessionHeader(root.id) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toMatch(/filename="gitea-audit-log-\d{8}-\d{6}Z\.jsonl"/);
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l !== "");
    // The filter mirrored from the listing (?action= exact): the two
    // organization:delete rows (the seeded one + the createOrg... no — only
    // the seeded one matches the exact action).
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(row.action).toBe(AuditActions.OrganizationDelete);
    expect(row.origin).toBe("ui");
    expect(row.scope).toEqual({ type: "organization", id: String(org.id), name: "acme" });
    // No X-Total-Count (the module header's recorded reduction — no COUNT
    // arm on the keyset read).
    expect(res.headers.get("x-total-count")).toBeNull();
  });

  it("sorts ascending across scopes (audit.go:31's override beats ?sort=desc)", async () => {
    await seedEvent({ timestamp: new Date(TS0.getTime() + 2000) });
    await seedEvent({
      action: AuditActions.OrganizationDelete,
      scopeType: "organization",
      scopeId: String(org.id),
      scopeName: "acme",
      vars: { scope: "acme" },
      timestamp: new Date(TS0.getTime() + 1000),
    });
    // The exact-action mirror keeps the fixtures' create emits out of the
    // wire (they ride different actions).
    const res = await fetchUi(`${EXPORT_PATH}?sort=timestamp_desc&action=${encodeURIComponent(AuditActions.OrganizationDelete)}`, {
      headers: { cookie: await sessionHeader(root.id) },
    });
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    // The ASC override beats the request's ?sort=desc: seed a second,
    // older matching row and it must come FIRST on the wire.
    await seedEvent({
      action: AuditActions.OrganizationDelete,
      scopeType: "organization",
      scopeId: String(org.id),
      scopeName: "acme",
      vars: { scope: "acme" },
      timestamp: new Date(TS0.getTime() - 1000),
      ipAddress: "203.0.113.8",
    });
    const older = await fetchUi(`${EXPORT_PATH}?sort=timestamp_desc&action=${encodeURIComponent(AuditActions.OrganizationDelete)}`, {
      headers: { cookie: await sessionHeader(root.id) },
    });
    const olderLines = (await older.text()).split("\n").filter((l) => l !== "");
    expect(olderLines).toHaveLength(2);
    const first = JSON.parse(olderLines[0] as string) as { time: string };
    const second = JSON.parse(olderLines[1] as string) as { time: string };
    expect(first.time < second.time).toBe(true); // oldest FIRST — the forced ASC
  });
});

// --- the route claim pins (parse ↔ registration — the applications-matrix pin) ---

describe("the route claim pins (the monitor group claims exactly the audit pair)", () => {
  it("parses both shapes; misspellings and deeper tails stay unclaimed", () => {
    expect(parseUiRoute(PAGE_PATH)).toEqual({ family: "admin-monitor-audit-logs" });
    expect(parseUiRoute(EXPORT_PATH)).toEqual({ family: "admin-monitor-audit-logs-export" });
    expect(handlesUiRoute(PAGE_PATH)).toBe(true);
    expect(handlesUiRoute(EXPORT_PATH)).toBe(true);
    expect(parseUiRoute("/-/admin/monitor/audit_log")).toBeNull();
    expect(parseUiRoute("/-/admin/monitor/audit_logs/extra")).toBeNull();
    expect(parseUiRoute("/-/admin/audit_logs")).toBeNull();
    expect(handlesUiRoute("/-/admin/monitor/audit_logs/extra")).toBe(false);
  });
});
