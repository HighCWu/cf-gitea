/**
 * The ADMIN AUDIT LOG page — census B-70 (§15 AD11), the arm the monitor
 * family omitted "for a reason that stopped being true": the audit_event
 * store (SPEC-0015, services/audit.ts) and the user-twin viewer
 * (pages/settings-audit-logs.tsx) landed after the monitor wave's note, so
 * the omission rode a STALE premise. This module re-opens the arm over the
 * landed seams: upstream
 *
 *   GET /-/admin/monitor/audit_logs         ViewAuditLogs   (audit.go:21-26)
 *   GET /-/admin/monitor/audit_logs/export  ExportAuditLogs (audit.go:28-71)
 *
 * (web.go:797-798, the FIRST two claims of the monitor group, behind the
 * group's `verifyAuthWithOptionsWeb{SignInRequired, AdminRequired}` —
 * web.go:779; the same ladder every landed admin page rides — anonymous
 * 303s onto the login round-trip, a signed-in non-admin 404-shells).
 * ViewAuditLogs is a 6-line handler: the SHARED audit renderer
 * (routers/web/shared/audit) with Template "admin/audit/list" and
 * `PageIsAdminMonitorAudit` — the admin arm differs from the user/org/repo
 * twins ONLY in leaving the scope empty ("The admin view leaves ScopeType
 * empty to list every event", shared/audit/audit.go:21-30; the handler calls
 * SearchOptionsFromRequest(ctx, "", 0)). This module is that admin frame:
 * the SHARED renderer is settings-audit-logs.tsx's (the same filter parse,
 * actor resolution, keyset walk and list component — the loader's scope is
 * optional since B-70, `undefined` = the instance-wide stream), and the page
 * is admin/audit/list.tmpl verbatim: pageClass `admin monitor`, the
 * `.admin-setting-content` wrapper, the `flex-left-right` h4 (the title +
 * the export button), the never-rendering `audit.disabled` banner arm, then
 * the shared list.
 *
 * ## The nav (the fold LANDED in this unit — coordinator-granted files)
 *
 * Upstream lights the Monitoring submenu's audit_logs item (navbar.tmpl:
 * 106-124 — FIRST in the menu, label audit.title, the group opens on
 * PageIsAdminMonitorAudit). The shared AdminFamilyNav (pages/
 * admin-users.tsx) gains the item in THIS unit — the fold hunks
 * (`monitor-audit` in AdminFamilyNavActive, adminFamilyLocale.auditLogs,
 * the open arm, the first-position item) and the stale "audit_logs
 * omitted" docstring flips in admin-users.tsx + admin-monitor.tsx ride
 * coordinator-granted ownership (disclosed in the unit report); no staged
 * wrapper ships. admin-monitor.test.tsx:943's negative pin
 * (`not.toContain("/-/admin/monitor/audit_logs")`) pins the monitor PAGES'
 * nav — those pages never carried the item in their OWN bodies, the pin
 * stays true (the nav is the shared component; it now renders the item on
 * every admin page like upstream's navbar.tmpl does).
 *
 * ## The export (ExportAuditLogs — the census row's "CSV" arm is JSONL)
 *
 * The census B-70 derivation says "the CSV export arm"; the PIN says NDJSON:
 * ExportAuditLogs serves `application/x-ndjson; charset=utf-8` as
 * `gitea-audit-log-<YYYYMMDD-HHMMSSZ>.jsonl` (audit.go:47-52) and the locale
 * label is "Export JSONL" (audit.export). Re-derive-at-pin wins. The arm
 * mirrors the listing's filters (SearchOptionsFromRequest(ctx, "", 0) — the
 * SAME parse, so an unknown actor still matches nothing), then overrides:
 * Sort = TimestampAsc (audit.go:31) and pageSize 1000 (audit.go:19). The
 * writer is services/audit/export.go WriteEventsAsJSON: one JSON object per
 * line, the `eventJSON` shape of models/audit/audit_event.go:57-70 in Go's
 * field order with its omitempty arms:
 *
 *   {"action", "actor":{type,id?,name?}, "actor_credential"?,
 *    "impersonator"?, "scope":{type,id?,name?}, "message", "metadata"?,
 *    "time", "ip_address", "origin"}
 *
 *   - actor/impersonator ids are NUMBERS (the users.id integer space, like
 *     upstream's int64); the SCOPE id carries cf-gitea's own id space
 *     verbatim — the repositories.id UUID / the decimal users.id string the
 *     emit seam keyed (the schema's scope_id drift note) — omitted when
 *     empty (upstream's omitempty zero, the system scope). The export
 *     reflects OUR rows; parsers key our ids, not upstream's.
 *   - `time` is RFC3339; second-precision stamps render Go-exact (no
 *     fractional seconds — timeutil.TimeStamp is seconds); sub-second
 *     stamps carry our millisecond precision (cosmetic).
 *   - `metadata` decodes the stored JSON; a junk row omits the field
 *     (DecodeMetadata's empty-map posture).
 *
 * Documented reductions (the honest deltas, each with its reason):
 *   - The stream pages the keyset read at the service's MAX limit (50,
 *     services/audit.ts) instead of upstream's 1000-row OFFSET pages —
 *     same wire bytes, the walk is the settings module's pager section
 *     inverted (cursor forward, no page-number semantics).
 *   - `X-Total-Count` (audit.go:52 — "lets a client detect an export
 *     truncated by a mid-stream failure") is OMITTED: a total would need a
 *     service-level COUNT the keyset read does not serve (the settings
 *     module's own recorded pager reduction); a mid-stream failure here
 *     surfaces as a truncated body/connection error, which is the failure
 *     the header existed to make detectable.
 *   - The `audit.disabled` warning (admin/audit/list.tmpl:9-11, locale
 *     audit.disabled) renders NEVER: cf-gitea's seam records
 *     unconditionally (no RECORD_OUTPUT seam — the settings module's
 *     reduction note, now on its home page).
 *
 * ## Mount record (MOUNTED this wave — ui/index.ts admin region)
 *
 *   GET  /-/admin/monitor/audit_logs         the page (adminPagePrologue —
 *                                            anonymous 303, non-admin 404
 *                                            shell, admin 200)
 *   GET  /-/admin/monitor/audit_logs/export  the NDJSON stream (same gate)
 *
 * Both are GET-only upstream; the POSTs answer chi's 405 (the compare
 * family's methodNotAllowed convention, the settings-audit-logs twins).
 *
 * ## THE NAV FOLD (LANDED in this unit — the hunks as applied)
 *
 *   1. AdminFamilyNavActive gains `"monitor-audit"` (the AdminMonitorPage
 *      sibling naming).
 *   2. adminFamilyLocale gains `auditLogs: "Audit Log"` (the navbar label IS
 *      audit.title, navbar.tmpl:110-112 — not "admin.monitor.audit_logs";
 *      upstream keys the shared audit.title).
 *   3. The monitor open arm gains the id.
 *   4. The Monitoring menu renders the item FIRST (navbar.tmpl:110-112)
 *      ahead of stats.
 *   5. The stale "audit_logs omitted / NOT ported" docstrings flip:
 *      admin-monitor.tsx (the surface list :36-37, the reduction note
 *      :138-140, the nav comment :653-654) and admin-users.tsx (the family
 *      header + the nav omission list) — B-70 is the reason those reasons
 *      died.
 */

import { drizzle } from "drizzle-orm/d1";

import { findAuditEvents, type AuditEventRow } from "../../services/audit";
import { AdminFamilyNav } from "./admin-users";
import {
  AuditLogList,
  parseAuditFilters,
  resolveAuditActorId,
  settingsAuditLogsLocale,
  AUDIT_SORT_ASC,
  type AuditFilters,
  type AuditLogsPageData,
} from "./settings-audit-logs";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern; upstream en-US values at
// the pin, keys cited — admin/audit/list.tmpl + the audit locale block)
// ---------------------------------------------------------------------------

export const adminAuditLogsLocale = {
  /** The export button (audit.export — the PIN's label is JSONL, not the
   *  census row's "CSV"). */
  export: "Export JSONL", // "audit.export" (admin/audit/list.tmpl:6)
} as const;

/** The page's link root (the mount's literal). */
export const ADMIN_AUDIT_LOGS_PAGE_LINK = "/-/admin/monitor/audit_logs";

// ---------------------------------------------------------------------------
// The export arm (ExportAuditLogs, audit.go:28-71)
// ---------------------------------------------------------------------------

/** The service's page cap IS the export's page size: upstream walks
 *  1000-row OFFSET pages (auditExportPageSize, audit.go:19); the keyset
 *  service caps limit at 50 (services/audit.ts) — the export walks 50-row
 *  keyset pages instead, same wire bytes (the module header's reduction). */
export const AUDIT_EXPORT_PAGE_SIZE = 50;

/** The export filename stamp: Go's "20060102-150405Z" layout over UTC
 *  (audit.go:49). */
export function adminAuditLogExportFilename(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(
    now.getUTCHours(),
  )}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return `gitea-audit-log-${stamp}.jsonl`;
}

/**
 * The export button's href: `$.Page.GetParams` (admin/audit/list.tmpl:5) —
 * the request's non-empty query params MINUS page, "?" only when any param
 * survives (a bare first visit links the bare export URL). The audit form's
 * param set in DOM order keeps the bytes deterministic (the settings
 * module's auditPageHref convention; an UNKNOWN action value still rides —
 * upstream's GetParams carries raw params, not the parsed filter set).
 */
export function adminAuditExportHref(pageLink: string, query: URLSearchParams): string {
  const params: string[] = [];
  for (const name of ["sort", "action", "origin", "actor"] as const) {
    const value = query.get(name) ?? "";
    if (value !== "") params.push(`${name}=${encodeURIComponent(value)}`);
  }
  return params.length === 0 ? pageLink : `${pageLink}?${params.join("&")}`;
}

/** RFC3339 with Go's second-precision arm: timeutil.TimeStamp is seconds, so
 *  a whole-second stamp renders without fractional seconds (Go time.Time's
 *  RFC3339Nano drops zero nanos); our sub-second stamps keep milliseconds. */
function exportTimestamp(createdUnix: Date): string {
  const iso = createdUnix.toISOString();
  return iso.endsWith(".000Z") ? iso.slice(0, iso.length - 5) + "Z" : iso;
}

/**
 * One NDJSON line: the `eventJSON` projection (audit_event.go:57-70 +
 * MarshalJSON :78-92) in Go's field order with its omitempty arms — the
 * module header carries the per-field cites (numeric actor/impersonator
 * ids, the scope id in cf-gitea's own space, the junk-metadata omission).
 */
export function auditEventAsJsonLine(row: AuditEventRow): string {
  const line: Record<string, unknown> = { action: row.action };
  const actor: Record<string, unknown> = { type: "user" };
  if (row.actorId !== 0) actor.id = row.actorId;
  if (row.actorName !== "") actor.name = row.actorName;
  line.actor = actor;
  if (row.actorCredential !== null && row.actorCredential !== "") {
    line.actor_credential = row.actorCredential;
  }
  if (row.impersonatorId !== 0 || (row.impersonatorName ?? "") !== "") {
    const impersonator: Record<string, unknown> = { type: "user" };
    if (row.impersonatorId !== 0) impersonator.id = row.impersonatorId;
    if ((row.impersonatorName ?? "") !== "") impersonator.name = row.impersonatorName;
    line.impersonator = impersonator;
  }
  const scope: Record<string, unknown> = { type: row.scopeType };
  if (row.scopeId !== "") scope.id = row.scopeId;
  if ((row.scopeName ?? "") !== "") scope.name = row.scopeName;
  line.scope = scope;
  line.message = row.message;
  if (row.metadata !== null) {
    try {
      const decoded: unknown = JSON.parse(row.metadata);
      if (decoded !== null && typeof decoded === "object" && Object.keys(decoded).length > 0) {
        line.metadata = decoded;
      }
    } catch {
      // junk metadata omits the field (DecodeMetadata's empty posture)
    }
  }
  line.time = exportTimestamp(row.createdUnix);
  line.ip_address = row.ipAddress ?? "";
  line.origin = row.origin;
  return JSON.stringify(line) + "\n";
}

/**
 * The export's ReadableStream: the listing's filters (the SAME parse —
 * audit.go:30's SearchOptionsFromRequest(ctx, "", 0)) with the sort forced
 * ascending (audit.go:31), walking keyset pages of AUDIT_EXPORT_PAGE_SIZE
 * until a short page ends the data. One enqueue per walked page (the whole
 * page's lines concatenated) — the body streams; nothing buffers the
 * export in memory (the Workers rules' unbounded-body posture).
 */
export function openAuditLogExportStream(
  d1: D1Database,
  query: URLSearchParams,
  actorId: number | null,
): ReadableStream<Uint8Array> {
  const db = drizzle(d1);
  const filters: AuditFilters = parseAuditFilters(query);
  // The where-clause mirrors the loader's admin arm (no scope pair) with the
  // sort override; an unknown actor's -1 still matches nothing (the service's
  // eq(-1) pair — the parse contract, not a special case here).
  const baseQuery = {
    ...(filters.action !== "" ? { action: filters.action } : {}),
    ...(filters.actionPrefix !== "" ? { actionPrefix: filters.actionPrefix } : {}),
    ...(actorId !== null ? { actorId } : {}),
    ...(filters.origin !== undefined ? { origin: filters.origin } : {}),
    sort: AUDIT_SORT_ASC,
  };
  const encoder = new TextEncoder();
  let cursor: { createdUnix: Date; id: number } | undefined = undefined;
  let pending: string[] = [];
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (pending.length > 0) {
          controller.enqueue(encoder.encode(pending.join("")));
          pending = [];
          return;
        }
        if (done) {
          controller.close();
          return;
        }
        const rows = await findAuditEvents(db, { ...baseQuery, cursor, limit: AUDIT_EXPORT_PAGE_SIZE });
        pending = rows.map(auditEventAsJsonLine);
        if (rows.length < AUDIT_EXPORT_PAGE_SIZE) {
          done = true; // the short page flushes, the next pull closes
          continue;
        }
        const last = rows[rows.length - 1];
        if (last === undefined) {
          done = true; // unreachable — rows.length >= PAGE_SIZE
          continue;
        }
        cursor = { createdUnix: last.createdUnix, id: last.id };
      }
    },
  });
}

/**
 * The export Response (the handler's whole arm): the actor resolution
 * rides the shared loader's helper (audit.go:57-64's GetUserByName arm —
 * a miss matches nothing), the headers carry upstream's content type +
 * attachment filename (audit.go:47-51; X-Total-Count omitted — the module
 * header's recorded reduction), and the body is the stream.
 */
export async function adminAuditLogExportResponse(
  d1: D1Database,
  query: URLSearchParams,
  now: Date,
): Promise<Response> {
  const actorId = await resolveAuditActorId(d1, parseAuditFilters(query).actor);
  return new Response(openAuditLogExportStream(d1, query, actorId), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${adminAuditLogExportFilename(now)}"`,
    },
  });
}

// ---------------------------------------------------------------------------
// The page (admin/audit/list.tmpl verbatim)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). `query` is the request's search params — the export button's
 *  href mirrors them (adminAuditExportHref's GetParams arm). */
export function renderAdminAuditLogsPage(options: {
  ctx: UiContext;
  data: AuditLogsPageData;
  query: URLSearchParams;
}): string {
  return renderPage(
    <AdminAuditLogsPage
      ctx={options.ctx}
      data={options.data}
      exportHref={adminAuditExportHref(`${ADMIN_AUDIT_LOGS_PAGE_LINK}/export`, options.query)}
    />,
  );
}

/**
 * The admin audit page (admin/audit/list.tmpl: the `admin monitor` layout,
 * the h4 flex-left-right with the export button, the never-rendering
 * audit.disabled banner — the module header's reduction — and the shared
 * list over the instance-wide stream; the nav is the FOLDED shared
 * AdminFamilyNav with `monitor-audit` lit — AdminMonitorShell's container
 * DOM, which is itself AdminFamilyShell's).
 */
export function AdminAuditLogsPage(props: { ctx: UiContext; data: AuditLogsPageData; exportHref: string }) {
  return (
    <BaseLayout ctx={props.ctx} title={settingsAuditLogsLocale.title} pageClass="admin monitor">
      <div class="ui container fluid padded flex-container">
        {/* AdminMonitorShell's exact nav threading (packagesEnabled only —
            the Integrations gate defaults enabled); the shared nav renders
            the audit item FIRST in the monitor menu (navbar.tmpl:110-112),
            lit by this page's `monitor-audit` active value. */}
        <AdminFamilyNav
          active="monitor-audit"
          packagesEnabled={props.ctx.packagesEnabled !== false}
        />
        <div class="flex-container-main">
          <div class="admin-setting-content">
            {/* list.tmpl:3-8 — the flex-left-right h4: the title span + the
                export button (octicon-download, the allowlisted icon). */}
            <h4 class="ui top attached header flex-left-right">
              <span>{settingsAuditLogsLocale.title}</span>
              <a class="ui primary small button" href={props.exportHref}>
                <Icon name="octicon-download" size={16} />
                {adminAuditLogsLocale.export}
              </a>
            </h4>
            {/* list.tmpl:9-13 — the audit.disabled warning renders never
                (the seam records unconditionally; the module header's
                reduction). */}
            {/* list.tmpl:14 — the shared list (templates/shared/audit/list). */}
            <AuditLogList data={props.data} pageLink={ADMIN_AUDIT_LOGS_PAGE_LINK} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
