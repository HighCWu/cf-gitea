/**
 * The SETTINGS AUDIT LOG pages — the census R13 row + R20's `+audit_logs`
 * arm over the landed M4 audit seam (SPEC-0015): upstream web.go:1279's
 * `m.Get("/audit_logs", repo_setting.ViewAuditLogs)` (the repo settings arm)
 * and web.go:1069's `m.Get("/audit_logs", org_setting.ViewAuditLogs)` (the
 * org settings arm), both 13-line handlers over ONE shared renderer —
 * `routers/web/shared/audit` (ViewOptions/SearchOptionsFromRequest/View,
 * shared/audit/audit.go) — feeding `templates/{repo,org}/settings/
 * audit_logs.tmpl`, each a pageClass + h4 + `{{template "shared/audit/list"}}`
 * wrapper around the SAME `templates/shared/audit/list.tmpl`. This module is
 * that shared renderer: one loader + one list component, two thin page
 * components (the repo one on the repo-settings family's SettingsNav, the
 * org one on the org family's OrgSettingsNavbar — the navbar items light up
 * navbar.tmpl:60-62 / org navbar.tmpl:50-52, LAST in both upstream menus).
 *
 * ## Scope (the M4 instrumentation's encoding — the pages key the SAME values)
 *
 *   - repo page: scope_type "repository" + scope_id `repo.id` — the
 *     `repositories.id` UUID the slice-one create emit keyed
 *     (repos/service.ts:336-338, `scopeId: id`, the client-minted UUID known
 *     before the batch).
 *   - org page: scope_type "organization" + scope_id String(org.id) — the
 *     decimal `users.id` string the org-create emit keyed through its
 *     `cast(id as text)` subquery (services/orgs/orgs.ts:473, the schema's
 *     scope_id drift note).
 *
 * A repository event therefore NEVER renders on an org page and vice versa —
 * the scope pair is the loader's base where-clause, not a post-filter.
 *
 * ## The query (SearchOptionsFromRequest port, shared/audit/audit.go:37-77)
 *
 *   - sort: only the exact value "timestamp_asc" upgrades the default DESC
 *     (audit.go:39's Iif — anything else falls back).
 *   - action: a REGISTERED action id filters exactly; else a known filter
 *     prefix (actionFilters()) filters `prefix:%`; else NEITHER (an unknown
 *     value filters nothing and the select re-renders "All actions" —
 *     audit.go:47-53's MessageTemplate/IsActionFilter if-else). The service
 *     owns the same precedence (exact wins, services/audit.ts AuditEventQuery).
 *   - origin: one of ui/api/cli/system (audit.go:32's filterableOrigins),
 *     else ignored.
 *   - actor: trimmed, resolved by name (GetUserByName — any users row, org
 *     rows included; user.go:1132-1134); a miss resolves to -1 so it MATCHES
 *     NOTHING rather than everything (audit.go:57-64 — `opts.ActorID = -1`),
 *     and the service's actor arm is an OR across actor_id and
 *     impersonator_id (audit_event.go:182-184), so an impersonated event
 *     answers both principals' trails.
 *   - page: `max(FormInt("page"), 1)` (audit.go:86) with the clamp below.
 *
 * ## The pager (upstream paginates with ListOptions OFFSET; ours is the
 * keyset service — the honest reduction is upstream's own unlimited arm)
 *
 * Upstream builds `NewPagerBuilder(ctx).TotalCount(total)...` and renders
 * `base/paginate` with a full numbered window (25/page — NoticePagingNum,
 * ui.go:140; Build's navPageNum default 5). The landed findAuditEvents is a
 * keyset read (no COUNT arm, services/audit.ts): the loader keeps upstream's
 * `?page=N` URL contract and WALKS to page N over keyset pages (a short or
 * empty step is the data end — the paginator's
 * `current = min(current, totalPages)` clamp, paginator.go:52), then probes
 * one row past the page for hasNext. The pager renders paginate.tmpl's
 * "unlimited paging" shape — pagination.go:69's "total=-1 means only showing
 * prev/next", SetUnlimitedPaging's single-page hiding arm (paginator.go:67-72:
 * page 1 without a next renders NO pager at all), and Pages()' unknown-total
 * collapse to the current page only (paginator.go:155-157 — one
 * class="item" anchor, no href, never active-highlighted at pagesLen 1,
 * paginate.tmpl:36-37). No First/Last buttons (paginate.tmpl's showFirstLast
 * = TotalPages > 1, false at -1). The chevron glyphs are outside the icon
 * allowlist (the repo-wiki octicon-chevron-right precedent) — the
 * navigation_label texts carry the arms. Requests beyond AUDIT_PAGE_WALK_MAX
 * clamp (the walk budget — upstream's OFFSET answers any depth in one query;
 * the keyset walk pays the skip as repeated reads, so the URL-hardening bound
 * keeps a hostile ?page=9999999 from walking forever; page MAX's Next renders
 * disabled at the bound).
 *
 * ## Row rendering (shared/audit/list.tmpl:40-82 verbatim anatomy)
 *
 * Actor cell: the impersonator FIRST when present (Impersonator() returns nil
 * only when id and name are both zero/empty, audit_event.go:49-54 — the "as"
 * line rides audit.impersonating_as), then the actor (an empty snapshot name
 * renders audit.deleted.actor "(removed)"; EntityRef.HasLink = name non-empty
 * AND id > 0, entity.go:47-49 — the link is `/{name}`), then the
 * ActorCredential code line. Scope cell: the snapshot name, "System" for the
 * system scope (entity.go:24-26), else audit.deleted.type "(removed {type}
 * with ID {id})". Action + origin render as `<code>` cells; Details is the
 * STORED rendered message (the seam renders at emit time — the page never
 * re-renders a template); IP is blank when null (upstream's empty string);
 * Timestamp is DateUtils.FullTime (the formatMonitorFullTime twin —
 * admin-monitor.tsx's UTC port of util_date.go:33). The timestamp th carries
 * upstream's data-sortt-* attrs verbatim (tablesort.ts drives them off the
 * bundle) with the admin-users SortHeader no-JS link added: the label toggles
 * the sort param keeping every other param (tablesort.ts:16-21's exact
 * behavior — page INCLUDED), and the triangle mirrors sortArrow's arms
 * (util_misc.go:29-53: no arrow without an explicit ?sort, up on asc, down on
 * desc; the triangles ride AdminEmbeddedSvg like admin-users').
 *
 * ## Documented reductions
 *
 * - The audit.disabled banner renders never here: it is the ADMIN list's arm
 *   (admin/audit/list.tmpl:9-11) — the shared repo/org list template carries
 *   no recording gate, and cf-gitea's seam records unconditionally.
 * - The sort header is a LINK (upstream's th is tablesort-JS-only) — the
 *   admin-users SortHeader convention, the family's no-JS reachability rule.
 * - The pager's number window and First/Last collapse to the unlimited arm
 *   (above) — a total count would need a service-level COUNT the keyset read
 *   does not serve.
 * - The user settings audit arm (navbar.tmpl:36-38 / web.go:748) stays
 *   unclaimed — the census R13 scope is the repo + org settings families.
 *
 * ## Mount record (MOUNTED this wave — the routes are live)
 *
 *   GET /{owner}/{repo}/settings/audit_logs   the repo settings arm (the
 *                                             settingsGate admin posture —
 *                                             the whole upstream group closes
 *                                             behind reqRepoAdmin, web.go:
 *                                             1283-1286; anonymous 303s onto
 *                                             login, a signed-in non-admin
 *                                             404-shells, the tags-page
 *                                             siblings' exact posture)
 *   GET /{org}/settings/audit_logs            the org settings arm (the
 *                                             org-teams require-owner
 *                                             prologue — anonymous 303s, a
 *                                             member non-owner 404-shells,
 *                                             upstream's RequireOwner
 *                                             OrgAssignment NotFound)
 *
 * Both are GET-only upstream; the POSTs answer chi's 405 (the compare
 * family's methodNotAllowed registration convention).
 */

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { users } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import {
  actionFilters,
  findAuditEvents,
  messageTemplate,
  type AuditEventRow,
  type AuditEventSort,
  type AuditOrigin,
  type AuditScopeType,
} from "../../services/audit";
import { AdminEmbeddedSvg } from "./admin-users";
import { formatMonitorFullTime } from "./admin-monitor";
import { SettingsNav } from "./settings";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { OrgSettingsNavbar } from "../components/settings-nav";
import { OrgHeader } from "./org-home";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern; upstream en-US values at
// the pin, keys cited — shared/audit/list.tmpl + the audit locale block)
// ---------------------------------------------------------------------------

export const settingsAuditLogsLocale = {
  /** The navbar tab, the page Title (shared/audit/audit.go:82) and the h4
   *  (repo/settings/audit_logs.tmpl:3). */
  title: "Audit Log", // "audit.title"
  actor: "Actor", // "audit.actor" (list.tmpl:30)
  scope: "Scope", // "audit.scope" (list.tmpl:31)
  action: "Action", // "audit.action" (list.tmpl:32)
  origin: "Origin", // "audit.origin" (list.tmpl:33)
  details: "Details", // "audit.details" (list.tmpl:34)
  ip_address: "IP Address", // "audit.ip_address" (list.tmpl:35)
  timestamp: "Timestamp", // "audit.timestamp" (list.tmpl:36)
  no_events: "There are no audit events matching the filter.", // "audit.no_events" (list.tmpl:84)
  impersonating_as: "as", // "audit.impersonating_as" (list.tmpl:49)
  deleted_actor: "(removed)", // "audit.deleted.actor" (list.tmpl:58)
  deleted_scope: "(removed %[1]s with ID %[2]v)", // "audit.deleted.type" (list.tmpl:72)
  filter_actor: "Filter by actor…", // "audit.filter.actor" (list.tmpl:5)
  filter_action: "All actions", // "audit.filter.action" (list.tmpl:10)
  filter_origin: "All origins", // "audit.filter.origin" (list.tmpl:18)
  search: "Search…", // "search.search" (the search button's aria, shared/search/button.tmpl)
  previous: "Previous", // "repo.issues.previous" (paginate.tmpl:20)
  next: "Next", // "repo.issues.next" (paginate.tmpl:40)
} as const;

/** The system scope's display name (entity.go:24-26 — Name-else-"System"). */
const SYSTEM_SCOPE_NAME = "System";

// ---------------------------------------------------------------------------
// The filter parse (SearchOptionsFromRequest's request half, audit.go:37-77)
// ---------------------------------------------------------------------------

/** The sort/link param values (list.tmpl:36's data-sortt pair). */
export const AUDIT_SORT_ASC: AuditEventSort = "timestamp_asc";
export const AUDIT_SORT_DESC: AuditEventSort = "timestamp_desc";

/** The filterable origins (shared/audit/audit.go:32). */
export const AUDIT_FILTERABLE_ORIGINS: AuditOrigin[] = ["ui", "api", "cli", "system"];

/** The parsed filter state — the loader's query inputs and the form's
 *  re-render values (upstream publishes the same pair as
 *  EventSearchOptions + the AuditFilter* ctx.Data flags). */
export interface AuditFilters {
  /** Only the exact "timestamp_asc" upgrades the default DESC (audit.go:39). */
  sort: AuditEventSort;
  /** The exact-action filter — a REGISTERED action id (audit.go:47-49). */
  action: string;
  /** The family-prefix filter — a known filter but not an action (audit.go:
   *  50-52). Mutually exclusive with `action` by construction (the exact arm
   *  wins the if-else). */
  actionPrefix: string;
  /** One of AUDIT_FILTERABLE_ORIGINS, else undefined (audit.go:54). */
  origin: AuditOrigin | undefined;
  /** The trimmed actor name (audit.go:57 — FormTrim). Resolved to an id at
   *  load; an unknown name matches nothing, never everything. */
  actor: string;
  /** max(FormInt("page"), 1) (audit.go:86) — junk reads as 1. */
  page: number;
  /** Whether a non-empty ?sort= rode the request (SortArrow's urlSort
   *  arm, util_misc.go:31-33 — the default DESC render carries no arrow;
   *  carried as a parse-time flag so the render stays pure). */
  sortExplicit: boolean;
}

/** Parse the request's query string into the filter state. Pure. */
export function parseAuditFilters(query: URLSearchParams): AuditFilters {
  const sortRaw = query.get("sort");
  const actionRaw = query.get("action") ?? "";
  const originRaw = query.get("origin") ?? "";
  const pageRaw = query.get("page") ?? "";
  // The exact arm wins the if-else (audit.go:47-53): a registered ACTION
  // (one with a message template — MessageTemplate(action) ok) filters
  // exactly; else a known FILTER (the actionFilters() set — never the
  // one-segment family root) filters as a prefix; an unknown value filters
  // neither and the select re-renders "All actions".
  let action = "";
  let actionPrefix = "";
  if (actionRaw !== "") {
    if (messageTemplate(actionRaw) !== undefined) {
      action = actionRaw;
    } else if (actionFilters().includes(actionRaw)) {
      actionPrefix = actionRaw;
    }
  }
  const page = /^\d+$/.test(pageRaw) ? Number.parseInt(pageRaw, 10) : 0;
  return {
    sort: sortRaw === AUDIT_SORT_ASC ? AUDIT_SORT_ASC : AUDIT_SORT_DESC,
    action,
    actionPrefix,
    origin: (AUDIT_FILTERABLE_ORIGINS as string[]).includes(originRaw) ? (originRaw as AuditOrigin) : undefined,
    actor: (query.get("actor") ?? "").trim(),
    page: Math.max(page, 1),
    sortExplicit: sortRaw !== null && sortRaw !== "",
  };
}

// ---------------------------------------------------------------------------
// The load (View's FindEvents half + the keyset walk — the module header's
// pager section holds the upstream cites)
// ---------------------------------------------------------------------------

/** The page size: upstream renders NoticePagingNum events/page (ui.go:140 —
 *  25 at the pin), so the loader passes 25 to the service (the DEFAULT 30
 *  stays the API family's default; the web page matches the web upstream). */
export const AUDIT_PAGE_SIZE = 25;

/** The deepest renderable page (the walk budget — the module header's
 *  URL-hardening bound). Upstream's OFFSET paging answers any depth in one
 *  query; the keyset walk pays the skip as repeated reads, so the bound caps
 *  a hostile ?page=9999999 at AUDIT_PAGE_WALK_MAX * AUDIT_PAGE_SIZE rows
 *  walked. Page MAX's Next renders disabled at the bound. */
export const AUDIT_PAGE_WALK_MAX = 50;

/** The scope pair the two mounts key (the module header's encoding section —
 *  repository: the repositories.id UUID; organization: the decimal users.id
 *  string). */
export interface AuditScopePair {
  type: Extract<AuditScopeType, "repository" | "organization">;
  id: string;
}

/** The listing's render inputs: the page's rows, the (clamped) page, the
 *  probe's hasNext, the parsed filters (the form's re-render values) and the
 *  select's effective action value (exact || prefix — upstream's
 *  AuditFilterAction, audit.go:67-70). */
export interface AuditLogsPageData {
  events: AuditEventRow[];
  page: number;
  hasNext: boolean;
  filters: AuditFilters;
  filterAction: string;
}

/**
 * View's read half (shared/audit/audit.go:81-105) over the landed
 * findAuditEvents: the scope pair + the parsed filters form the base query,
 * the keyset walk reaches `page`, and a one-row probe past the page decides
 * hasNext (a short page is the data end — upstream's
 * HasNext = current*pagingNum < total). See the module header for the walk's
 * upstream citation set.
 */
export async function loadSettingsAuditLogs(
  d1: D1Database,
  scope: AuditScopePair,
  query: URLSearchParams,
): Promise<AuditLogsPageData> {
  const filters = parseAuditFilters(query);
  const actorId = await resolveAuditActorId(d1, filters.actor);
  // Raw binding in, drizzle wrapped here (the tag-module page-loader
  // convention) — the service's findAuditEvents takes the wrapped type.
  const db = drizzle(d1);
  // The base where-clause: the scope pair is UNCONDITIONAL (the scope pair
  // is the page's identity — a repository event never renders on an org page
  // and vice versa), the filters ride only when set (the service's own
  // exact-wins action precedence mirrors the parse).
  const baseQuery = {
    scopeType: scope.type,
    scopeId: scope.id,
    ...(filters.action !== "" ? { action: filters.action } : {}),
    ...(filters.actionPrefix !== "" ? { actionPrefix: filters.actionPrefix } : {}),
    ...(actorId !== null ? { actorId } : {}),
    ...(filters.origin !== undefined ? { origin: filters.origin } : {}),
    sort: filters.sort,
  };
  // The walk: requested pages beyond the data clamp to the last non-empty
  // page (paginator.go:52's current = min(current, totalPages)); a partial
  // step IS the last page and renders in place.
  let page = Math.min(filters.page, AUDIT_PAGE_WALK_MAX);
  let cursor: { createdUnix: Date; id: number } | undefined = undefined;
  let previousCursor: { createdUnix: Date; id: number } | undefined = undefined;
  let events: AuditEventRow[] = [];
  if (page > 1) {
    let walked = 1;
    while (walked < page) {
      const step = await findAuditEvents(db, { ...baseQuery, cursor, limit: AUDIT_PAGE_SIZE });
      if (step.length === 0) {
        // The previous page was exactly full and the data ended: the last
        // page is `walked - 1`, whose rows the PREVIOUS cursor reaches.
        page = Math.max(walked - 1, 1);
        cursor = previousCursor;
        break;
      }
      if (step.length < AUDIT_PAGE_SIZE) {
        // A short step is the final page — render it (the clamp in place).
        page = walked;
        events = step;
        break;
      }
      previousCursor = cursor;
      const last = step[step.length - 1];
      if (last === undefined) break; // unreachable — step.length ≥ PAGE_SIZE
      cursor = { createdUnix: last.createdUnix, id: last.id };
      walked += 1;
    }
  }
  if (events.length === 0) {
    events = await findAuditEvents(db, { ...baseQuery, cursor, limit: AUDIT_PAGE_SIZE });
    if (events.length === 0 && page > 1) {
      // The requested page sits beyond the data because the last page was
      // EXACTLY full (total ≡ 0 mod page size): the walk consumed the full
      // pages and the final fetch hit the empty boundary — step back one
      // page (the previous cursor reaches it, non-empty by construction;
      // the paginator.go:52 current clamp again).
      page -= 1;
      events = await findAuditEvents(db, { ...baseQuery, cursor: previousCursor, limit: AUDIT_PAGE_SIZE });
    }
  }
  // The probe: one row past the page (limit 1) — only when the page came
  // back exactly full (a short page is definitionally the last). At the walk
  // bound the probe is suppressed: the bound's Next renders disabled.
  let hasNext = false;
  if (events.length === AUDIT_PAGE_SIZE && page < AUDIT_PAGE_WALK_MAX) {
    const last = events[events.length - 1];
    if (last !== undefined) {
      const probe = await findAuditEvents(db, {
        ...baseQuery,
        cursor: { createdUnix: last.createdUnix, id: last.id },
        limit: 1,
      });
      hasNext = probe.length > 0;
    }
  }
  return {
    events,
    page,
    hasNext,
    filters,
    filterAction: filters.action !== "" ? filters.action : filters.actionPrefix,
  };
}

/** The actor filter's id resolution (audit.go:57-64): GetUserByName by the
 *  lowercased name — any users row (org rows carry ids in the same space,
 *  user.go:1132-1134's no-type-filter lookup); the miss returns -1 so the
 *  filter MATCHES NOTHING (never everything). Null = the empty input (no
 *  filter — upstream leaves ActorID zeroed). */
export async function resolveAuditActorId(d1: D1Database, actor: string): Promise<number | null> {
  if (actor === "") return null;
  const row = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, actor.toLowerCase()))
    .limit(1)
    .get();
  return row === undefined ? -1 : row.id;
}

// ---------------------------------------------------------------------------
// The link builder (paginate.tmpl's `?page=N{{if params}}&{{params}}{{end}}`
// over AddParamFromRequest — page dropped, empty values dropped)
// ---------------------------------------------------------------------------

/**
 * One pager/sort link's href: the page param first, then the non-empty
 * filter params in the form's DOM order (upstream's GetParams keeps every
 * non-empty query param but page; the fixed order keeps the bytes
 * deterministic).
 */
export function auditPageHref(pageLink: string, filters: AuditFilters, page: number, sortOverride?: AuditEventSort): string {
  const sort = sortOverride ?? filters.sort;
  const params: string[] = [];
  if (page !== 1) params.push(`page=${page}`);
  params.push(`sort=${sort}`);
  if (filters.action !== "") params.push(`action=${encodeURIComponent(filters.action)}`);
  if (filters.actionPrefix !== "") params.push(`action=${encodeURIComponent(filters.actionPrefix)}`);
  if (filters.origin !== undefined) params.push(`origin=${filters.origin}`);
  if (filters.actor !== "") params.push(`actor=${encodeURIComponent(filters.actor)}`);
  return `${pageLink}?${params.join("&")}`;
}

// ---------------------------------------------------------------------------
// The shared list (templates/shared/audit/list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The scope cell's display projection (entity.go:20-28 + list.tmpl:64-74):
 *  the snapshot name, else "System" for the system scope, else "" (the
 *  deleted arm). */
function scopeDisplayName(row: AuditEventRow): string {
  if (row.scopeName !== null && row.scopeName !== "") return row.scopeName;
  return row.scopeType === "system" ? SYSTEM_SCOPE_NAME : "";
}

/** EntityRef.HasLink (entity.go:47-49): a home link exists only with a name
 *  AND a positive id — the system scope's empty id never links. */
function entityHasLink(row: AuditEventRow, name: string): boolean {
  return name !== "" && row.scopeId !== "" && row.scopeId !== "0";
}

/** The audit.deleted.type text with its args substituted (list.tmpl:72). */
function deletedScopeText(row: AuditEventRow): string {
  return settingsAuditLogsLocale.deleted_scope.replace("%[1]s", row.scopeType).replace("%[2]v", row.scopeId);
}

/** The sort arrow (sortArrow's arms, util_misc.go:29-53): no arrow without
 *  an explicit ?sort, up on asc, down on desc (the triangles are outside the
 *  allowlist — AdminEmbeddedSvg renders them, the admin-users precedent). */
function SortArrow(props: { sort: AuditEventSort; explicit: boolean }) {
  if (!props.explicit) return null;
  return props.sort === AUDIT_SORT_ASC ? (
    <AdminEmbeddedSvg name="octicon-triangle-up" size={16} />
  ) : (
    <AdminEmbeddedSvg name="octicon-triangle-down" size={16} />
  );
}

/**
 * The shared audit list — list.tmpl:1-89 verbatim: the filter form segment
 * (the actor input + search button, the action select over the registry's
 * filter set, the origin select, the hidden sort carrier), the striped table
 * (the scoped-th a11y convention — upstream's bare th cells carry scope="col"
 * here), the empty-state row, and the pager.
 */
export function AuditLogList(props: { data: AuditLogsPageData; pageLink: string }) {
  const { data } = props;
  const filters = data.filters;
  const hasPrevious = data.page > 1;
  // paginate.tmpl renders nothing only when the unlimited pager collapsed to
  // a single page (SetUnlimitedPaging's total-pages arm, paginator.go:67-72).
  const pagerVisible = data.page !== 1 || data.hasNext;
  return (
    <>
      {/* list.tmpl:1-25 — the filter form segment (GET — no method/action
          attrs submit the current URL; the hidden sort re-carries it). */}
      <div class="ui attached segment">
        <form class="ui form ignore-dirty tw-flex tw-flex-wrap tw-gap-2">
          <input type="hidden" name="sort" value={filters.sort} />
          <div class="ui small action input tw-flex-1">
            <input type="text" name="actor" value={filters.actor} placeholder={settingsAuditLogsLocale.filter_actor} />
            <button type="submit" class="ui small icon button" aria-label={settingsAuditLogsLocale.search}>
              <Icon name="octicon-search" />
            </button>
          </div>
          <div class="ui small input">
            <select class="ui dropdown" name="action">
              <option value="">{settingsAuditLogsLocale.filter_action}</option>
              {actionFilters().map((action) => (
                <option selected={data.filterAction === action || undefined} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </div>
          <div class="ui small input">
            <select class="ui dropdown" name="origin">
              <option value="">{settingsAuditLogsLocale.filter_origin}</option>
              {AUDIT_FILTERABLE_ORIGINS.map((origin) => (
                <option selected={filters.origin === origin || undefined} value={origin}>
                  {origin}
                </option>
              ))}
            </select>
          </div>
        </form>
      </div>
      {/* list.tmpl:26-88 — the striped table. */}
      <div class="ui attached table segment">
        <table class="ui very basic striped table unstackable">
          <thead>
            <tr>
              <th scope="col">{settingsAuditLogsLocale.actor}</th>
              <th scope="col">{settingsAuditLogsLocale.scope}</th>
              <th scope="col">{settingsAuditLogsLocale.action}</th>
              <th scope="col">{settingsAuditLogsLocale.origin}</th>
              <th scope="col">{settingsAuditLogsLocale.details}</th>
              <th scope="col">{settingsAuditLogsLocale.ip_address}</th>
              {/* list.tmpl:36 — the upstream data-sortt attrs stay verbatim
                  (the bundle's tablesort drives them); the no-JS toggle is
                  the admin-users SortHeader link below. */}
              <th scope="col" data-sortt-asc="timestamp_asc" data-sortt-desc="timestamp_desc">
                <a href={auditPageHref(props.pageLink, filters, data.page, filters.sort === AUDIT_SORT_ASC ? AUDIT_SORT_DESC : AUDIT_SORT_ASC)}>
                  {settingsAuditLogsLocale.timestamp}
                  <SortArrow sort={filters.sort} explicit={filters.sortExplicit} />
                </a>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.events.length === 0 ? (
              <tr>
                <td colspan={7}>{settingsAuditLogsLocale.no_events}</td>
              </tr>
            ) : (
              data.events.map((row) => (
                <tr>
                  {/* list.tmpl:42-63 — the actor cell: impersonator first
                      (Impersonator() nils when id and name are both zero),
                      then the actor, then the credential line. */}
                  <td>
                    {row.impersonatorId !== 0 || (row.impersonatorName ?? "") !== "" ? (
                      <>
                        {row.impersonatorName ? (
                          row.impersonatorId > 0 ? (
                            <a href={`/${row.impersonatorName}`}>{row.impersonatorName}</a>
                          ) : (
                            row.impersonatorName
                          )
                        ) : null}
                        <span class="text small"> {settingsAuditLogsLocale.impersonating_as}</span>
                      </>
                    ) : null}
                    {row.actorName !== "" ? (
                      row.actorId > 0 ? (
                        <a href={`/${row.actorName}`}>{row.actorName}</a>
                      ) : (
                        row.actorName
                      )
                    ) : (
                      <span class="text small">{settingsAuditLogsLocale.deleted_actor}</span>
                    )}
                    {row.actorCredential ? (
                      <div>
                        <code class="text small">{row.actorCredential}</code>
                      </div>
                    ) : null}
                  </td>
                  {/* list.tmpl:64-74 — the scope cell. */}
                  <td>
                    {(() => {
                      const name = scopeDisplayName(row);
                      if (name === "") return <span class="text small">{deletedScopeText(row)}</span>;
                      return entityHasLink(row, name) ? <a href={`/${name}`}>{name}</a> : name;
                    })()}
                  </td>
                  <td>
                    <code>{row.action}</code>
                  </td>
                  <td>
                    <code>{row.origin}</code>
                  </td>
                  {/* list.tmpl:77-80 — the STORED rendered message (the seam
                      renders at emit time; the page never re-renders). */}
                  <td>{row.message}</td>
                  <td>{row.ipAddress ?? ""}</td>
                  <td>{formatMonitorFullTime(row.createdUnix)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {/* base/paginate — the unlimited-paging shape (the module header's
          pager section): Previous / the bare current-page item / Next, the
          chevron glyphs outside the allowlist (the labels carry the arms). */}
      {pagerVisible ? (
        <div class="center page buttons">
          <div class="ui borderless pagination menu">
            <a
              class={`${hasPrevious ? "" : "disabled "}item navigation`}
              href={hasPrevious ? auditPageHref(props.pageLink, filters, data.page - 1) : undefined}
            >
              <span class="navigation_label">{settingsAuditLogsLocale.previous}</span>
            </a>
            {/* paginate.tmpl:34-38 — the unknown-total window collapses to
                the current page, never active-highlighted at pagesLen 1 and
                never carrying an href (IsCurrent). */}
            <a class="item">{data.page}</a>
            <a
              class={`${data.hasNext ? "" : "disabled "}item navigation`}
              href={data.hasNext ? auditPageHref(props.pageLink, filters, data.page + 1) : undefined}
            >
              <span class="navigation_label">{settingsAuditLogsLocale.next}</span>
            </a>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The two page components (repo/settings/audit_logs.tmpl +
// org/settings/audit_logs.tmpl — the shared list wrapped in each family's
// layout + h4)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderRepoSettingsAuditLogsPage(options: { ctx: UiContext; data: AuditLogsPageData }): string {
  return renderPage(<RepoSettingsAuditLogsPage ctx={options.ctx} data={options.data} />);
}

/**
 * The repo settings audit page (repo/settings/audit_logs.tmpl: pageClass
 * `repository settings`, the `.repo-setting-content` wrapper, the h4, the
 * shared list). The settings navbar rides the shared SettingsNav with the
 * new audit tab active (navbar.tmpl:60-62's last position).
 */
export function RepoSettingsAuditLogsPage(props: { ctx: UiContext; data: AuditLogsPageData }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoSettingsAuditLogsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const pageLink = `${repoLink}/settings/audit_logs`;
  return (
    <BaseLayout ctx={ctx} title={settingsAuditLogsLocale.title} pageClass="repository settings">
      <div class="ui container flex-container">
        <SettingsNav repoLink={repoLink} active="audit" repo={repo} />
        <div class="flex-container-main">
          {/* repo/settings/audit_logs.tmpl:2-5 — the content wrapper + h4. */}
          <div class="repo-setting-content">
            <h4 class="ui top attached header">{settingsAuditLogsLocale.title}</h4>
            <AuditLogList data={props.data} pageLink={pageLink} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document render (the org twin). */
export function renderOrgSettingsAuditLogsPage(options: { ctx: UiContext; org: OrgRecord; data: AuditLogsPageData }): string {
  return renderPage(<OrgSettingsAuditLogsPage ctx={options.ctx} org={options.org} data={options.data} />);
}

/**
 * The org settings audit page (org/settings/audit_logs.tmpl: pageClass
 * `organization settings` — no options quirk here, the OrgHeader + the
 * shared OrgSettingsNavbar with the new audit tab active (org navbar.tmpl:
 * 50-52's last position), the `.org-setting-content` wrapper, the h4, the
 * shared list).
 */
export function OrgSettingsAuditLogsPage(props: { ctx: UiContext; org: OrgRecord; data: AuditLogsPageData }) {
  const { ctx, org } = props;
  const orgLink = `/${org.username}`;
  const pageLink = `${orgLink}/settings/audit_logs`;
  return (
    <BaseLayout ctx={ctx} title={settingsAuditLogsLocale.title} pageClass="organization settings">
      <OrgHeader org={org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="audit" />
        <div class="flex-container-main">
          {/* org/settings/audit_logs.tmpl:2-5 — the content wrapper + h4. */}
          <div class="org-setting-content">
            <h4 class="ui top attached header">{settingsAuditLogsLocale.title}</h4>
            <AuditLogList data={props.data} pageLink={pageLink} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
