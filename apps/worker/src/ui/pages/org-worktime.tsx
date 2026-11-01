/**
 * The organization WORKTIME page — `/{org}/worktime` (census gap #20's
 * aggregate view) — upstream web.go:1015's
 * `m.Get("/worktime", context.OrgAssignment(...{RequireOwner: true}), org.Worktime)`
 * inside the require-owner `/{org}` group (web.go:1008-1092), served by
 * `org.Worktime` (routers/web/org/worktime.go:46-88) over
 * `organization.GetWorktimeByRepos/Milestones/Members`
 * (models/organization/org_worktime.go:16-119) and rendered by
 * templates/org/worktime.tmpl + org/worktime/{table_repos,table_milestones,
 * table_members,empty_placeholder}.tmpl. PORT-FIRST: the module owns the
 * load + render; the route lives behind the orchestrator's index.ts fold
 * (the mount recipe at the bottom of this header).
 *
 * ## URL shape (the landed require-owner family convention)
 *
 * Upstream nests this route under `m.Group("/org", ...)` — the wire path is
 * `/org/{org}/worktime` — but the landed port serves the require-owner org
 * group at the bare `/{org}/...` shapes (teams `/{org}/teams` wave-12,
 * labels `/{org}/labels` wave-14, settings `/{org}/settings` wave-49 — each
 * a recorded family divergence with the same reason: the second-segment
 * literal claims before the repo parse). The worktime page rides the SAME
 * convention: `/{org}/worktime`, the literal `worktime` second segment
 * claimed before the tail parse could read it as a repository named
 * "worktime" (the teams/labels/settings precedent; upstream shadows such a
 * repo identically — the org group registers ahead of the dynamic
 * `/{username}/{reponame}` pair). The template's own links confirm the
 * family shape: worktime.tmpl builds them from `$.Org.OrganisationLink`
 * (= "/org/{name}" upstream, models/user/user.go:352-354) + "/worktime".
 *
 * ## The gate (RequireOwner, services/context/org.go:144)
 *
 * The route's OrgAssignment carries ONLY RequireOwner: a signed-in doer who
 * is not an org owner 404-shells (NotFound), a site admin passes (the
 * IsAdmin super-access arm, org.go:118-123), an anonymous viewer hits the
 * group's `reqSignIn` first (web.go:1103) and 303s onto the login
 * round-trip. The landed `resolveOrgTeamsRequest` posture is exactly this
 * ladder; this module exports the TESTABLE composition
 * `resolveOrgWorktimePage` (the same order: resolve → rename-307/miss-404 →
 * anonymous-login → owner gate) so the handler glue in index.ts stays a
 * 5-arm outcome map.
 *
 * ## Data (the org_worktime.go ports over the landed tracked_times store)
 *
 * The landed `tracked_times` table (schema.ts — upstream
 * models/issues/tracked_time.go:16-26) carries the same columns the
 * aggregates join: `tracked_time ⋈ issue ⋈ repository` (+ `⋈ milestone`
 * LEFT, `⋈ user` for the members arm), `repository.owner_id = org.id`,
 * `tracked_time.deleted = false`, `created_unix` between the parsed range
 * (inclusive both ends), GROUP BY the arm's dimension. The by-members arm
 * orders `sum_time DESC` (org_worktime.go:111); by-repos/milestones order
 * by name (the milestones arm re-sorts in-process exactly upstream's
 * pgsql-NULL fix, org_worktime.go:73-81 — repo, deadline (NULL → 0, so
 * undated milestones first), id — then clears the deadline and flags
 * `HideRepoName` on every row after a row of the same repo, :83-91).
 *
 * ## The range (parseOrgTimes, worktime.go:16-42)
 *
 * `from` defaults to the first of the current month, `to` to today; both
 * parse STRICTLY as `2006-01-02` (UTC midnight — Go time.Parse's location);
 * a junk value is upstream's ServerError (a 500, not a 404 — the module's
 * `{outcome: "error"}` arm, the artifacts-download posture). `unixTo` adds
 * 1440 minutes minus 1 second: humans expect the ending day INCLUDED
 * (worktime.go:38). The landed clock convention is UTC throughout (the
 * formatAdminDate posture), so the defaults derive from the injected `now`'
 * UTC date parts — deterministic under the tests' fixed clock.
 *
 * ## DOM contract (worktime.tmpl at the pin)
 *
 * pageClass `organization times`, then the shared org header (the landed
 * OrgHeader — the teams/labels/members family precedent; upstream
 * org/header.tmpl embeds org/menu.tmpl whose Worktime tab renders for
 * owners, but the landed family renders NO menu strip — every landed org
 * page drops it, the tab-strip rule reduced to the pages that exist; the
 * menu's other tabs are the family's documented omissions), then the
 * `.ui.grid` split: the THREE-wide filter column (the GET form: the hidden
 * `by` echo, the two `<input type="date">` fields, the Query button) and
 * the THIRTEEN-wide result column (the by-switcher `.ui.compact.small.menu`
 * — three links carrying `by=` + the preserved from/to — then the arm's
 * table). Table rows: repos (repo glyph + `{org}/{repo}/issues` link, clock
 * + Sec2Hours), milestones (repo cell SUPPRESSED on HideRepoName rows, the
 * milestone link `{org}/{repo}/milestone/{id}` or a bare "-", clock +
 * Sec2Hours), members (person glyph + `/{name}` link, clock + Sec2Hours).
 * An empty result renders the empty_placeholder row (48px clock, the two
 * locale lines) with the table's colspan.
 *
 * ## Documented reductions (§6 method)
 *
 * - `Sec2Hours` is upstream's util.SecToHours verbatim
 *   (modules/util/sec_to_time.go:15-29 + formatTime:32-44): whole
 *   hours+minutes, seconds rendered only when neither is nonzero.
 * - The date inputs are native `<input type="date">` (no JS calendar).
 * - `EnableTimetracking` (menu.tmpl:47's tab gate) has no landed flag — the
 *   tracked-times service is always present, so the page never 404s on a
 *   feature flag.
 *
 * ## Mount recipe (the orchestrator's index.ts fold)
 *
 * 1. `UiRoute` gains `{ family: "org-worktime"; owner: string }` (the
 *    org-teams union's shape).
 * 2. `parseUiRoute`, beside the `repo === "teams"` / `"labels"` /
 *    `"settings"` literal claims (the second-segment literal block):
 *
 *      if (repo === "worktime") {
 *        if (raw.length === 3) return { family: "org-worktime", owner };
 *        return null;
 *      }
 *
 * 3. Handler (the org-settings page's exact shape):
 *
 *      async function orgWorktimePage(c: Context<{ Bindings: Env }>) {
 *        const resolved = await resolveUiSession(c);
 *        if (!resolved.ok) return resolved.response;
 *        const { url, ctx, viewer, respond } = resolved;
 *        if (resolved.route.family !== "org-worktime") return respond(await c.notFound());
 *        const outcome = await resolveOrgWorktimePage(c.env.DB, resolved.route.owner, viewer, url.pathname,
 *          url.search.startsWith("?") ? url.search.slice(1) : url.search);
 *        if (outcome.kind === "redirect") return respond(new Response(null, { status: 307, headers: { location: outcome.location } }));
 *        if (outcome.kind === "signin") return respond(new Response(null, { status: 303, headers: { location: outcome.location } }));
 *        if (outcome.kind !== "page") return respond(c.html(renderNotFound(ctx), 404)); // missing + forbidden
 *        const loaded = await loadOrgWorktimeData(c.env.DB, outcome.org, url.searchParams);
 *        if (loaded.outcome === "error") return respond(c.text("server error", 500)); // parseOrgTimes' ServerError arm
 *        return respond(c.html(renderOrgWorktimePage(ctx, loaded.data), 200));
 *      }
 *
 * 4. Registration BESIDE THE WAVE-12 STATICS (the RegExpRouter rule — a
 *    static registered after the dynamic owner/repo pair loses;
 *    `/:owner/teams` at index.ts:16607 is the precedent slot):
 *
 *      uiRouter.get("/:owner/worktime", (c) => orgWorktimePage(c));
 */

import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { OrgProfileDoer } from "../../api/services/orgs";
import { issues, milestones, repositories, trackedTimes, users } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { canManageOrgTeams, resolveOrgTeamsOrg } from "./org-teams";
import { orgDisplayName, OrgHeader } from "./org-home";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const orgWorktimeLocale = {
  worktime: "Worktime", // "org.worktime" (menu.tmpl:49 — the tab label; the page Title's family arm)
  date_range_start: "Start date", // "org.worktime.date_range_start"
  date_range_end: "End date", // "org.worktime.date_range_end"
  query: "Query", // "org.worktime.query"
  by_repositories: "By repositories", // "org.worktime.by_repositories"
  by_milestones: "By milestones", // "org.worktime.by_milestones"
  by_members: "By members", // "org.worktime.by_members"
  time: "Time", // "org.worktime.time"
  empty: "No worktime data yet.", // "org.worktime.empty"
  empty_description: "Adjust the date range to view tracked time.", // "org.worktime.empty_description"
  repository: "Repository", // "repository" (the repos + milestones tables' first header)
  milestone: "Milestone", // "repo.milestone" (the milestones table's second header)
  member: "Member", // "org.members.member" (the members table's first header)
  no_milestone: "-", // table_milestones.tmpl:18's else arm (a bare dash)
} as const;

/** The three switcher arms (worktime.go:56-70's switch; the default is
 *  repos — the `default:` branch sets WorktimeByRepos). */
export type WorktimeBy = "repos" | "milestones" | "members";

/** One by-repos row (WorktimeSumByRepos, org_worktime.go:11-14). */
export interface WorktimeReposRow {
  repoName: string;
  sumTime: number;
}

/** One by-milestones row (WorktimeSumByMilestones, org_worktime.go:35-42):
 *  the deadline is upstream's internal sort key, cleared before render
 *  (org_worktime.go:87), so the render shape carries only the flag. */
export interface WorktimeMilestonesRow {
  repoName: string;
  /** null = the issue carries no milestone (the LEFT JOIN's null arm — the
   *  template's bare "-"). */
  milestoneName: string | null;
  milestoneId: number | null;
  sumTime: number;
  /** "Show only the first RepoName, for nicer output"
   *  (org_worktime.go:90) — true on every row after the first of a repo. */
  hideRepoName: boolean;
}

/** One by-members row (WorktimeSumByMembers, org_worktime.go:91-94). */
export interface WorktimeMembersRow {
  userName: string;
  sumTime: number;
}

/** The page's render inputs. `rows` discriminates on `by`. */
export interface OrgWorktimeData {
  org: OrgRecord;
  by: WorktimeBy;
  /** The echoed date strings (the form inputs' values — always present,
   *  defaulted or as-given). */
  rangeFrom: string;
  rangeTo: string;
  rows: WorktimeReposRow[] | WorktimeMilestonesRow[] | WorktimeMembersRow[];
}

// ---------------------------------------------------------------------------
// The range parse (worktime.go:16-42's parseOrgTimes)
// ---------------------------------------------------------------------------

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** `time.Parse("2006-01-02", …)` — UTC midnight, shape-checked first (the
 *  regex rejects the JS Date constructor's loose coercion arms, upstream's
 *  Go parse rejects them by grammar). null = the ServerError arm. */
export function parseWorktimeDate(raw: string): Date | null {
  if (!DATE_SHAPE.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  // The round-trip catches the grammar-legal but calendar-illegal shapes
  // (2026-02-31 rolls into March under the constructor).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatWorktimeDate(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** The parsed range (ctx.Data["RangeFrom"/"RangeTo"] + the two unix bounds
 *  after parseOrgTimes): the echoed strings plus the inclusive second
 *  range. */
export interface WorktimeRange {
  rangeFrom: string;
  rangeTo: string;
  unixFrom: number;
  /** `timeTo.Add(1440*time.Minute - 1*time.Second).Unix()` — the ending
   *  day's last second (worktime.go:38). */
  unixTo: number;
}

/**
 * parseOrgTimes (worktime.go:16-42): `from` defaults to the current month's
 * first day, `to` to today (the injected `now`'s UTC parts — the landed
 * clock convention; Go formats the defaults in server-local time and parses
 * them back as UTC, so a UTC-fixed port is the honest reduction). A junk
 * value answers `{ outcome: "error" }` — upstream's ctx.ServerError (a 500,
 * worktime.go:34/37), NOT a silent default.
 */
export function parseWorktimeRange(params: URLSearchParams, now: Date): { outcome: "ok"; range: WorktimeRange } | { outcome: "error" } {
  let rangeFrom = params.get("from") ?? "";
  let rangeTo = params.get("to") ?? "";
  if (rangeFrom === "") rangeFrom = formatWorktimeDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  if (rangeTo === "") rangeTo = formatWorktimeDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const timeFrom = parseWorktimeDate(rangeFrom);
  const timeTo = parseWorktimeDate(rangeTo);
  if (timeFrom === null || timeTo === null) return { outcome: "error" };
  const unixFrom = Math.floor(timeFrom.getTime() / 1000);
  return {
    outcome: "ok",
    range: {
      rangeFrom,
      rangeTo,
      unixFrom,
      unixTo: unixFrom + Math.floor((timeTo.getTime() - timeFrom.getTime()) / 1000) + 86_399,
    },
  };
}

/** `by` (worktime.go:56's FormString switch): unknown values fall to repos
 *  — the `default:` branch. */
export function parseWorktimeBy(params: URLSearchParams): WorktimeBy {
  const raw = params.get("by");
  return raw === "milestones" || raw === "members" ? raw : "repos";
}

// ---------------------------------------------------------------------------
// Sec2Hours (util.SecToHours — modules/util/sec_to_time.go:15-44 verbatim)
// ---------------------------------------------------------------------------

function formatTimePart(value: number, name: string, formatted: string): string {
  if (value === 1) return `${formatted}1 ${name} `;
  if (value > 1) return `${formatted}${value} ${name}s `;
  return formatted;
}

/** `{{.SumTime | Sec2Hour}}` — util.SecToHours: whole hours + minutes,
 *  seconds only when neither is nonzero (sec_to_time.go:25-26). */
export function secToHours(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  let formatted = formatTimePart(hours, "hour", "");
  formatted = formatTimePart(minutes, "minute", formatted);
  if (formatted === "" && seconds > 0) formatted = formatTimePart(seconds, "second", "");
  return formatted.trimEnd();
}

// ---------------------------------------------------------------------------
// The aggregates (org_worktime.go's three reads over the landed store)
// ---------------------------------------------------------------------------

/** The shared WHERE (org_worktime.go's four conditions, :27-30/:52-55/:100-103):
 *  the org's repos, live entries, the inclusive created range. */
function worktimeConditions(org: OrgRecord, range: WorktimeRange) {
  return and(
    eq(repositories.ownerId, org.id),
    eq(trackedTimes.deleted, false),
    gte(trackedTimes.createdAt, new Date(range.unixFrom * 1000)),
    lte(trackedTimes.createdAt, new Date(range.unixTo * 1000)),
  );
}

/** GetWorktimeByRepos (org_worktime.go:16-32): repo name ASC. */
async function getWorktimeByRepos(d1: D1Database, org: OrgRecord, range: WorktimeRange): Promise<WorktimeReposRow[]> {
  const rows = await drizzle(d1)
    .select({ repoName: repositories.slug, sumTime: sql<number>`sum(${trackedTimes.seconds})` })
    .from(trackedTimes)
    .innerJoin(issues, eq(issues.id, trackedTimes.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .where(worktimeConditions(org, range))
    .groupBy(repositories.slug)
    .orderBy(asc(repositories.slug))
    .all();
  return rows.map((row) => ({ repoName: row.repoName, sumTime: Number(row.sumTime ?? 0) }));
}

/** GetWorktimeByMembers (org_worktime.go:91-107): `sum_time DESC` — the
 *  expression repeated (D1 orders by the aggregate; the alias is a xorm
 *  convenience). */
async function getWorktimeByMembers(d1: D1Database, org: OrgRecord, range: WorktimeRange): Promise<WorktimeMembersRow[]> {
  const rows = await drizzle(d1)
    .select({ userName: users.username, sumTime: sql<number>`sum(${trackedTimes.seconds})` })
    .from(trackedTimes)
    .innerJoin(issues, eq(issues.id, trackedTimes.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .innerJoin(users, eq(users.id, trackedTimes.userId))
    .where(worktimeConditions(org, range))
    .groupBy(users.username)
    .orderBy(desc(sql`sum(${trackedTimes.seconds})`))
    .all();
  return rows.map((row) => ({ userName: row.userName, sumTime: Number(row.sumTime ?? 0) }));
}

/** GetWorktimeByMilestones (org_worktime.go:45-90): the LEFT JOIN groups
 *  repo+milestone, then upstream's in-process re-sort (repo, deadline with
 *  NULL → 0 first, id — the pgsql-NULL comment's guarantee), then the
 *  deadline clear + the HideRepoName pass (:83-91). */
async function getWorktimeByMilestones(d1: D1Database, org: OrgRecord, range: WorktimeRange): Promise<WorktimeMilestonesRow[]> {
  const rows = await drizzle(d1)
    .select({
      repoName: repositories.slug,
      milestoneName: milestones.name,
      milestoneId: milestones.id,
      milestoneDeadline: milestones.deadlineAt,
      sumTime: sql<number>`sum(${trackedTimes.seconds})`,
    })
    .from(trackedTimes)
    .innerJoin(issues, eq(issues.id, trackedTimes.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .leftJoin(milestones, eq(milestones.id, issues.milestoneId))
    .where(worktimeConditions(org, range))
    .groupBy(repositories.slug, milestones.name, milestones.deadlineAt, milestones.id)
    .all();
  const sorted = [...rows].sort((a, b) => {
    if (a.repoName !== b.repoName) return a.repoName < b.repoName ? -1 : 1;
    const deadlineA = a.milestoneDeadline === null ? 0 : Math.floor(a.milestoneDeadline.getTime() / 1000);
    const deadlineB = b.milestoneDeadline === null ? 0 : Math.floor(b.milestoneDeadline.getTime() / 1000);
    if (deadlineA !== deadlineB) return deadlineA - deadlineB;
    return (a.milestoneId ?? 0) - (b.milestoneId ?? 0);
  });
  let prevRepoName = "";
  return sorted.map((row) => {
    const hideRepoName = prevRepoName === row.repoName;
    prevRepoName = row.repoName;
    return {
      repoName: row.repoName,
      milestoneName: row.milestoneName,
      milestoneId: row.milestoneId,
      sumTime: Number(row.sumTime ?? 0),
      hideRepoName,
    };
  });
}

// ---------------------------------------------------------------------------
// The load + the gate composition
// ---------------------------------------------------------------------------

export type OrgWorktimeLoad = { outcome: "ok"; data: OrgWorktimeData } | { outcome: "error" };

/**
 * The Worktime handler's data pull (worktime.go:46-88): the range parse
 * (the ServerError arm surfaces as `outcome: "error"`), the `by` switch
 * over the three aggregate reads, the echo fields for the form.
 */
export async function loadOrgWorktimeData(
  d1: D1Database,
  org: OrgRecord,
  params: URLSearchParams,
  now: Date = new Date(),
): Promise<OrgWorktimeLoad> {
  const parsed = parseWorktimeRange(params, now);
  if (parsed.outcome === "error") return { outcome: "error" };
  const { range } = parsed;
  const by = parseWorktimeBy(params);
  const rows =
    by === "milestones"
      ? await getWorktimeByMilestones(d1, org, range)
      : by === "members"
        ? await getWorktimeByMembers(d1, org, range)
        : await getWorktimeByRepos(d1, org, range);
  return {
    outcome: "ok",
    data: { org, by, rangeFrom: range.rangeFrom, rangeTo: range.rangeTo, rows },
  };
}

/** The page outcome (the resolveOrgTeamsRequest ladder as a testable
 *  union): the resolved org, a rename redirect, the unknown-org 404, the
 *  anonymous login 303 (the group's reqSignIn, web.go:1103), the
 *  non-owner's 404 (RequireOwner, org.go:144). */
export type OrgWorktimeResolution =
  | { kind: "page"; org: OrgRecord }
  | { kind: "redirect"; location: string }
  | { kind: "missing" }
  | { kind: "signin"; location: string }
  | { kind: "forbidden" };

/**
 * The worktime page's full access ladder, in resolveOrgTeamsRequest's
 * order: the org resolution first (a renamed org 307s onto the new name,
 * an unknown name 404-shells), then the anonymous login 303, then
 * RequireOwner — `canManageOrgTeams` (site admin or the org's owner
 * membership, services/context/org.go:118-123's IsOwner composition) or
 * the 404 shell.
 */
export async function resolveOrgWorktimePage(
  d1: D1Database,
  owner: string,
  viewer: Viewer,
  requestPath: string,
  requestQuery: string,
): Promise<OrgWorktimeResolution> {
  const doer: OrgProfileDoer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const resolved = await resolveOrgTeamsOrg(d1, owner, doer, requestPath, requestQuery);
  if (resolved.kind === "redirect") return resolved;
  if (resolved.kind === "missing") return { kind: "missing" };
  if (viewer.kind === "anonymous") {
    return { kind: "signin", location: `/login?redirect_to=${encodeURIComponent(requestPath + (requestQuery === "" ? "" : `?${requestQuery}`))}` };
  }
  if (!(await canManageOrgTeams(d1, resolved.org, viewer))) return { kind: "forbidden" };
  return { kind: "page", org: resolved.org };
}

// ---------------------------------------------------------------------------
// The render (worktime.tmpl at the pin)
// ---------------------------------------------------------------------------

/** octicon-people's exact `<path d>` bytes — the pinned submodule's
 *  gitea/public/assets/img/svg/octicon-people.svg (the FOLD_SVG precedent):
 *  the switcher's members glyph is in neither the generated allowlist nor
 *  admin-users.tsx's embedded map, and neither file is this unit's. */
const PEOPLE_ICON_PATH =
  "M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.51 5.51 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.5 5.5 0 0 1 3.102 8.05 3.5 3.5 0 0 1 2 5.5M11 4a3.001 3.001 0 0 1 2.22 5.018 5 5 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.75.75 0 0 1-.549-.514 3.51 3.51 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4m-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5";

/** The embedded glyph (the AdminEmbeddedSvg DOM shape, module-local — this
 *  module is the only consumer). */
function PeopleSvg() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width={16} height={16} class="svg octicon-people" aria-hidden="true">
      <path d={PEOPLE_ICON_PATH} />
    </svg>
  );
}

/** The empty placeholder row (org/worktime/empty_placeholder.tmpl — the
 *  48px clock, the two locale lines, the caller's colspan). */
function EmptyPlaceholderRow(props: { colspan: number }) {
  return (
    <tr>
      <td colspan={props.colspan}>
        <div class="empty-placeholder">
          <Icon name="octicon-clock" size={48} />
          <h2>{orgWorktimeLocale.empty}</h2>
          <p>{orgWorktimeLocale.empty_description}</p>
        </div>
      </td>
    </tr>
  );
}

/** table_repos.tmpl (colspan 2). */
function ReposTable(props: { orgLink: string; rows: WorktimeReposRow[] }) {
  return (
    <table class="ui table">
      <thead>
        <tr>
          <th scope="col">{orgWorktimeLocale.repository}</th>
          <th scope="col">{orgWorktimeLocale.time}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <EmptyPlaceholderRow colspan={2} />
        ) : (
          props.rows.map((row) => (
            <tr>
              <td>
                <Icon name="octicon-repo" /> <a href={`${props.orgLink}/${row.repoName}/issues`}>{row.repoName}</a>
              </td>
              <td>
                <Icon name="octicon-clock" /> {secToHours(row.sumTime)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/** table_milestones.tmpl (colspan 3; the repo cell suppressed on
 *  HideRepoName rows, the milestone cell the id link or the bare dash). */
function MilestonesTable(props: { orgLink: string; rows: WorktimeMilestonesRow[] }) {
  return (
    <table class="ui table">
      <thead>
        <tr>
          <th scope="col">{orgWorktimeLocale.repository}</th>
          <th scope="col">{orgWorktimeLocale.milestone}</th>
          <th scope="col">{orgWorktimeLocale.time}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <EmptyPlaceholderRow colspan={3} />
        ) : (
          props.rows.map((row) => (
            <tr>
              <td>{row.hideRepoName ? null : (
                <>
                  <Icon name="octicon-repo" /> <a href={`${props.orgLink}/${row.repoName}/issues`}>{row.repoName}</a>
                </>
              )}</td>
              <td>
                {row.milestoneName !== null && row.milestoneId !== null ? (
                  <>
                    <Icon name="octicon-milestone" />{" "}
                    <a href={`${props.orgLink}/${row.repoName}/milestone/${row.milestoneId}`}>{row.milestoneName}</a>
                  </>
                ) : (
                  orgWorktimeLocale.no_milestone
                )}
              </td>
              <td>
                <Icon name="octicon-clock" /> {secToHours(row.sumTime)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/** table_members.tmpl (colspan 2; the profile link, person glyph). */
function MembersTable(props: { rows: WorktimeMembersRow[] }) {
  return (
    <table class="ui table">
      <thead>
        <tr>
          <th scope="col">{orgWorktimeLocale.member}</th>
          <th scope="col">{orgWorktimeLocale.time}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <EmptyPlaceholderRow colspan={2} />
        ) : (
          props.rows.map((row) => (
            <tr>
              <td>
                <Icon name="octicon-person" /> <a href={`/${row.userName}`}>{row.userName}</a>
              </td>
              <td>
                <Icon name="octicon-clock" /> {secToHours(row.sumTime)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/** The full-document render (the render.tsx pattern — index.ts stays a
 *  pure-TS router module). */
export function renderOrgWorktimePage(ctx: UiContext, data: OrgWorktimeData): string {
  return renderPage(<OrgWorktimePage ctx={ctx} data={data} />);
}

/** The worktime page (§2.4.1 discriminator: worktime.tmpl:2's literal
 *  `organization times`). */
export function OrgWorktimePage(props: { ctx: UiContext; data: OrgWorktimeData }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  // worktime.tmpl:18's QueryBuild — the switcher links carry the CURRENT
  // from/to (defaulted values included — parseOrgTimes always sets the
  // Data keys).
  const queryParams = `from=${encodeURIComponent(data.rangeFrom)}&to=${encodeURIComponent(data.rangeTo)}`;
  const switcherItem = (by: WorktimeBy, label: string, glyph: "repo" | "milestone" | "people") => (
    <a class={data.by === by ? "active item" : "item"} href={`${orgLink}/worktime?by=${by}&${queryParams}`}>
      {glyph === "repo" ? <Icon name="octicon-repo" /> : glyph === "milestone" ? <Icon name="octicon-milestone" /> : <PeopleSvg />} {label}
    </a>
  );
  return (
    <BaseLayout ctx={ctx} title={orgDisplayName(data.org)} pageClass="organization times">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container">
        <div class="ui grid">
          <div class="three wide column">
            {/* The filter form (worktime.tmpl:7-18): the hidden `by` echo
                keeps the current arm across the Query submit. */}
            <form class="ui form" method="get" action={`${orgLink}/worktime`}>
              <input type="hidden" name="by" value={data.by} />
              <div class="field">
                <label for="worktime-from">{orgWorktimeLocale.date_range_start}</label>
                <input id="worktime-from" type="date" name="from" value={data.rangeFrom} />
              </div>
              <div class="field">
                <label for="worktime-to">{orgWorktimeLocale.date_range_end}</label>
                <input id="worktime-to" type="date" name="to" value={data.rangeTo} />
              </div>
              <button type="submit" class="ui primary button">
                {orgWorktimeLocale.query}
              </button>
            </form>
          </div>
          <div class="thirteen wide column">
            <div class="ui column">
              <div class="ui compact small menu">
                {switcherItem("repos", orgWorktimeLocale.by_repositories, "repo")}
                {switcherItem("milestones", orgWorktimeLocale.by_milestones, "milestone")}
                {switcherItem("members", orgWorktimeLocale.by_members, "people")}
              </div>
            </div>
            {data.by === "milestones" ? (
              <MilestonesTable orgLink={orgLink} rows={data.rows as WorktimeMilestonesRow[]} />
            ) : data.by === "members" ? (
              <MembersTable rows={data.rows as WorktimeMembersRow[]} />
            ) : (
              <ReposTable orgLink={orgLink} rows={data.rows as WorktimeReposRow[]} />
            )}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
