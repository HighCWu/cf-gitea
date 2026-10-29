/**
 * The ADMIN EMAILS list page — `/-/admin/emails` — the census R18 (a) emails
 * arm (docs/compat/ui-gap-census-2026-10-29.md: "four page modules over the
 * declared services"): the route lives in `index.ts`'s admin literal family
 * block (the retired-wiring HANDOFF is the mount record at the bottom of
 * this header). Sibling scope: admin-users/admin-orgs/admin-repos own the
 * other three listings; this module owns the emails arm only.
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/emails/list.tmpl` served by `admin.Emails`
 * (routers/web/admin/emails.go:29-99), route `GET /-/admin/emails`
 * (web.go:821-824's `/emails` group `m.Get("")`), behind
 * `verifyAuthWithOptionsWeb(SignInRequired + AdminRequired)` (web.go:779) —
 * the shared adminPagePrologue's exact posture (anonymous → the login 303, a
 * signed-in non-admin → the 404 shell). The group's writes:
 * `m.Post("/activate", admin.ActivateEmail)` + `m.Post("/delete",
 * admin.DeleteEmail)` — BOTH LANDED here as the plain-form-POST arms (the
 * keys-page 303 convention; upstream drives them through the JS modal +
 * link-action JS, which the no-JS reduction replaces with per-row inline
 * forms).
 *
 * The handler's data pull (emails.go:29-99): Title = "admin.emails"
 * ("User Email Addresses" — the nav label; the panel header is
 * "admin.emails.email_manage_panel"), `user_model.SearchEmails`
 * (models/user/email_address.go:373-426) with the four sort arms
 * (email/reverseemail/username/reverseusername — the composite
 * "lower_email ASC, is_primary DESC, id ASC" strings at :340-345; junk folds
 * to the "email" default at :55-63), the `q` keyword (LIKE triple over
 * lower(full_name)/lower_name/email_address.lower_email — the instr() stand-in,
 * the admin-users precedent), the `is_activated`/`is_primary` optional
 * filters (emails.go:72-77 — read only when the param is NON-EMPTY, bool
 * from the `activated`/`primary` twins), page size
 * `setting.UI.Admin.UserPagingNum` = 50 (modules/setting/ui.go:138).
 *
 * ## Row projection (list.tmpl:44-79 at the pin → the landed D1 columns)
 *
 *   Username     users.username → /{username} (list.tmpl:46)
 *   Full Name    users.full_name ?? "" (list.tmpl:47)
 *   Email        email_addresses.email / the synthesized primary's users.email
 *   Primary      the check/x pair (list.tmpl:48)
 *   Activated    the check/x pair — a TOGGLE (the change-email arm) when
 *                CanChange (list.tmpl:50-62)
 *   (actions)    the octicon-trash delete (list.tmpl:64-70)
 *
 * THE SYNTHESIZED-PRIMARY DIVERGENCE (the module's central note): upstream
 * materializes the signup address as an is_primary email_address row at user
 * creation, so every SearchEmails row has an id and both writes can act.
 * cf-gitea keeps the primary on `users.email` and only SECONDARY addresses
 * get rows (schema.ts's emailAddresses header; the API twin unions the
 * primary back — routes/misc-t3.ts searchEmailEntries). So the page reads
 * the SAME union the declared GET /admin/emails answers (the census brief's
 * declared services): real rows JOIN users (type='user') + the synthesized
 * primary per user whose users.email has no row. A synthesized entry has NO
 * row id, and upstream's own write path would fail on it exactly the same
 * way (ActivateUserEmail looks the row up by (uid, lower_email) and errors
 * "no such email", email_address.go:405-409) — so the synthesized rows
 * render PLAIN state cells (no toggle, no trash; the dead-control rule) and
 * the reduction is upstream-faithful. CanChange (emails.go:86-88: the admin
 * cannot deactivate their OWN primary) reduces to `id !== null` — every real
 * row is a secondary (is_primary has no write path), and CanChange's other
 * arm (`Doer.ID != UID || !IsPrimary`) is true for every secondary.
 *
 * The is_activated/is_primary filters (read from the URL but rendered by NO
 * control upstream either — they ride the activate form's hidden preservation
 * inputs, list.tmpl:88-89) apply to the REAL-row query only; the synthesized
 * set is excluded when either filter is set (upstream's filters read the
 * email_address table alone). The activate POST's redirect preserves them
 * like upstream's builder (emails.go:126-141).
 *
 * ## Data (§3.2 — D1 through Drizzle; the service-layer gap recorded)
 *
 * The declared API family keeps its predicate route-private
 * (routes/misc-t3.ts searchEmailEntries — same module-local pattern as the
 * admin-users page). This module issues the admin predicate directly through
 * Drizzle (the admin-users.tsx §Data precedent): the union read + the JS
 * merge/sort/paginate the API twin established, upstream's SQL ORDER BY
 * strings mapped onto the comparator (the email keys over lower_email,
 * is_primary DESC, id ASC tiebreaks; a synthesized entry rides the same keys
 * with id treated as the smallest).
 *
 * ## Writes (emails.go:101-187 at the pin, the no-JS reduction)
 *
 *   POST /-/admin/emails/activate — ActivateEmail: the four
 *   truefalse-mapped form fields (uid/email/primary/activate — a malformed
 *   set is the handler's 400, emails.go:106-109); then ActivateUserEmail
 *   (email_address.go:399-449) minus the unreachable primary-sync arm: the
 *   (uid, lower_email) row lookup (miss → the "not_updated" flash arm →
 *   silent 303, the stale-form convention), the already-in-state no-op
 *   success, the IsEmailActive duplicate check on activate (another ACTIVE
 *   row with the address, or another ACTIVE user's users.email —
 *   ErrEmailAlreadyUsed → the "duplicate_active" arm → silent 303), then the
 *   row's is_activated update. Success → 303 back onto the list with the
 *   preserved q/sort/is_primary/is_activated (the upstream redirect builder;
 *   the flash texts have no renderable analog — the no-session-flash
 *   reduction the keys/hooks pages established).
 *   POST /-/admin/emails/delete — DeleteEmail: the (uid, id) row lookup
 *   (misses upstream 500 via ServerError — a stale form here 303s silently,
 *   the keys-page posture), the is_primary guard (unreachable: no write path
 *   sets it — kept as the honest arm, silent 303), then the row delete →
 *   303 back.
 *
 * ## Mount record (MOUNTED this wave — the route is live)
 *
 * Route table (`index.ts`), beside the landed adminPagePrologue listings:
 *
 *   GET  /-/admin/emails           adminPagePrologue → loadAdminEmailsData →
 *                                  renderAdminEmailsPage at 200
 *   POST /-/admin/emails/activate  sameOriginGuard + prologue →
 *                                  applyAdminEmailActivate → the 303
 *   POST /-/admin/emails/delete    sameOriginGuard + prologue →
 *                                  applyAdminEmailDelete → the 303
 *
 * The claims sit in the landed admin literal family block
 * (`raw[1] === "-" && raw[2] === "admin"`) — static literals beside
 * users/orgs/repos, ahead of any dynamic arm. The family navbar gains the
 * Email Addresses item (Identity & Access) and the whole Integrations group
 * — the census brief's nav fold; upstream navbar.tmpl's order kept (badges
 * before emails; Integrations = Applications + Webhooks between Assets and
 * Monitoring; auths/packages/config/notices/self_check/actions stay
 * omitted — the (b)/(c) census classes).
 */

import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { emailAddresses, users } from "../../db/schema";

import { parsePageNumber } from "../page-data";
import type { UiContext } from "../ui-context";
import {
  AdminEmbeddedSvg,
  AdminFamilyPagination,
  AdminFamilyShell,
  SortHeader,
} from "./admin-users";
import { Icon, renderPage } from "../shell";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminEmailsLocale = {
  email_manage_panel: "User Email Management", // "admin.emails.email_manage_panel" (list.tmpl:4)
  total: "Total: %d", // "admin.total" (list.tmpl:4)
  search_placeholder: "Search users…", // "search.user_kind" (the combo's input)
  search: "Search…", // "search.search" (the combo's submit — the explore text-button reduction)
  sort: "Sort", // "repo.issues.filter_sort" (list.tmpl:10)
  sort_email: "Email address", // "admin.emails.filter_sort.email"
  sort_email_reverse: "Email address (reverse)", // "admin.emails.filter_sort.email_reverse"
  sort_name: "Username", // "admin.emails.filter_sort.name"
  sort_name_reverse: "Username (reverse)", // "admin.emails.filter_sort.name_reverse"
  col_name: "Username", // "admin.users.name" (list.tmpl:36)
  col_full_name: "Full Name", // "admin.users.full_name" (list.tmpl:37)
  col_email: "Email Address", // "email" (list.tmpl:38)
  col_primary: "Primary", // "admin.emails.primary" (list.tmpl:39)
  col_activated: "Activated", // "admin.emails.activated" (list.tmpl:40)
  no_results: "No results found.", // "no_results_found" (list.tmpl:82)
  change_email_aria: "Update Email Properties", // "admin.emails.change_email_header" (the toggle's aria label — the icon-button additive)
  delete_email_aria: "Delete Email", // "admin.emails.delete" (the trash's aria label — the icon-button additive)
} as const;

/** Upstream `setting.UI.Admin.UserPagingNum` (modules/setting/ui.go:138) —
 *  the users page's shared admin page size. */
export const ADMIN_EMAILS_PAGE_SIZE = 50;

/** The four dropdown sorts (emails.go:55-63); the page default is "email"
 *  (the default arm also rewrites SortType, so junk never renders active). */
export type AdminEmailSort = "email" | "reverseemail" | "username" | "reverseusername";

/** `ctx.FormString("sort")`'s switch — unknown values fold onto "email"
 *  (emails.go:55-63's default arm). */
export function parseAdminEmailSort(raw: string | null): AdminEmailSort {
  switch (raw) {
    case "reverseemail":
    case "username":
    case "reverseusername":
      return raw;
    default:
      return "email";
  }
}

/** The optional filter param's tri-state: "1" | "0" | null (absent/empty —
 *  `len(ctx.FormString(...)) != 0` gate, emails.go:72-77). */
export type AdminEmailFilterValue = "1" | "0" | null;

/** The parsed query (the render's active-sort state + the pager's param set).
 *  isPrimary/isActivated parse the `is_primary`/`is_activated` params —
 *  rendered by NO control (the header's note); the POST redirect preserves
 *  whatever the URL carried. */
export interface AdminEmailsListParams {
  keyword: string;
  sort: AdminEmailSort;
  isPrimary: AdminEmailFilterValue;
  isActivated: AdminEmailFilterValue;
  page: number;
}

export function parseAdminEmailsListParams(params: URLSearchParams): AdminEmailsListParams {
  const filter = (name: string): AdminEmailFilterValue => {
    const raw = params.get(name);
    return raw === "1" || raw === "0" ? raw : null;
  };
  return {
    keyword: (params.get("q") ?? "").trim(),
    sort: parseAdminEmailSort(params.get("sort")),
    isPrimary: filter("is_primary"),
    isActivated: filter("is_activated"),
    page: parsePageNumber(params.get("page")),
  };
}

// ---------------------------------------------------------------------------
// The loader (§3.2 — the module header's union note)
// ---------------------------------------------------------------------------

/** One renderable row: a real email_addresses row (id) or the synthesized
 *  primary (id null — the module header's divergence note). */
export interface AdminEmailEntry {
  /** The email_addresses.id — null for the synthesized primary. */
  id: number | null;
  userId: number;
  username: string;
  fullName: string;
  email: string;
  isActivated: boolean;
  isPrimary: boolean;
  /** emails.go:86-88's CanChange — reduces to `id !== null` (the header). */
  canChange: boolean;
}

/** The page's render inputs. `query` is the pager's param set (q + the two
 *  filter params + an explicit sort, page excluded). */
export interface AdminEmailsData {
  params: AdminEmailsListParams;
  query: URLSearchParams;
  total: number;
  more: boolean;
  items: AdminEmailEntry[];
}

/**
 * The list load — `admin.Emails` → SearchEmails over the cf-gitea store:
 * real rows INNER JOIN users (type='user' — the individual family,
 * email_address.go:377), the keyword instr triple (lower(full_name) /
 * lower_name / lower_email, case-folded — the API twin's predicate), the two
 * optional filters over the row columns, then the SYNTHESIZED primaries
 * unioned in (the declared GET /admin/emails model) and the whole set sorted
 * by the composite order strings (email_address.go:340-345) in JS — the API
 * twin's merge posture. Paginated 50 per page over the merged array (the
 * twin's JS slice).
 */
export async function loadAdminEmailsData(
  d1: D1Database,
  doerId: number,
  search: URLSearchParams,
): Promise<AdminEmailsData> {
  const params = parseAdminEmailsListParams(search);
  const db = drizzle(d1);

  const conditions: SQL[] = [eq(users.type, "user")];
  if (params.keyword !== "") {
    const keyword = params.keyword.toLowerCase();
    conditions.push(sql`(
      instr(lower(coalesce(${users.fullName}, '')), ${keyword}) > 0
      or instr(${users.usernameLower}, ${keyword}) > 0
      or instr(${emailAddresses.lowerEmail}, ${keyword}) > 0
    )`);
  }
  if (params.isPrimary !== null) {
    conditions.push(eq(emailAddresses.isPrimary, params.isPrimary === "1"));
  }
  if (params.isActivated !== null) {
    conditions.push(eq(emailAddresses.isActivated, params.isActivated === "1"));
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      id: emailAddresses.id,
      userId: users.id,
      username: users.username,
      fullName: users.fullName,
      email: emailAddresses.email,
      isActivated: emailAddresses.isActivated,
      isPrimary: emailAddresses.isPrimary,
    })
    .from(emailAddresses)
    .innerJoin(users, eq(users.id, emailAddresses.userId))
    .where(where)
    .all();

  const entries: AdminEmailEntry[] = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    username: row.username,
    fullName: row.fullName ?? "",
    email: row.email,
    isActivated: row.isActivated,
    isPrimary: row.isPrimary,
    // emails.go:86-88's formula — collapses to true for every real row (the
    // header's note: secondaries only).
    canChange: doerId !== row.userId || !row.isPrimary,
  }));

  // The synthesized primaries — only when no row-column filter narrowed the
  // read (the header's note): the bare-users query mirrors the API twin's.
  if (params.isPrimary === null && params.isActivated === null) {
    const bareConditions: SQL[] = [
      eq(users.type, "user"),
      sql`${users.email} IS NOT NULL AND ${users.email} <> ''`,
    ];
    if (params.keyword !== "") {
      const keyword = params.keyword.toLowerCase();
      bareConditions.push(sql`(
        instr(lower(${users.email}), ${keyword}) > 0
        or instr(${users.usernameLower}, ${keyword}) > 0
        or instr(lower(coalesce(${users.fullName}, '')), ${keyword}) > 0
      )`);
    }
    const bare = await db
      .select({ id: users.id, username: users.username, fullName: users.fullName, email: users.email })
      .from(users)
      .where(and(...bareConditions))
      .all();
    const rowEmails = new Set(rows.map((row) => row.email.toLowerCase()));
    for (const user of bare) {
      if (rowEmails.has(user.email!.toLowerCase())) continue;
      entries.push({
        id: null,
        userId: user.id,
        username: user.username,
        fullName: user.fullName ?? "",
        email: user.email!,
        isActivated: true,
        isPrimary: true,
        // The synthesized primary: upstream CanChange is true for other
        // users' primaries, but no email_address row exists to carry the
        // write — the plain-state arm (the header).
        canChange: false,
      });
    }
  }

  // The composite order strings (email_address.go:340-345): the email key
  // over lower_email, the name key over `user`.lower_name; both carry the
  // is_primary DESC, id ASC tiebreaks (a synthesized entry sorts as id -1 —
  // no row exists; deterministic either way since emails are unique).
  const keyOf = (entry: AdminEmailEntry): string =>
    params.sort === "username" || params.sort === "reverseusername"
      ? entry.username.toLowerCase()
      : entry.email.toLowerCase();
  const reverse = params.sort === "reverseemail" || params.sort === "reverseusername";
  entries.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return (ka < kb ? -1 : 1) * (reverse ? -1 : 1);
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1; // is_primary DESC
    const ia = a.id ?? -1;
    const ib = b.id ?? -1;
    return (ia - ib) * (reverse ? -1 : 1); // id ASC (reversed with the key)
  });

  const total = entries.length;
  const start = (params.page - 1) * ADMIN_EMAILS_PAGE_SIZE;
  const items = entries.slice(start, start + ADMIN_EMAILS_PAGE_SIZE);

  const query = new URLSearchParams();
  if (params.keyword !== "") query.set("q", params.keyword);
  if (params.sort !== "email") query.set("sort", params.sort);
  if (params.isPrimary !== null) query.set("is_primary", params.isPrimary);
  if (params.isActivated !== null) query.set("is_activated", params.isActivated);

  return { params, query, total, more: params.page * ADMIN_EMAILS_PAGE_SIZE < total, items };
}

// ---------------------------------------------------------------------------
// The writes (emails.go:101-187 — the module header carries the port notes)
// ---------------------------------------------------------------------------

export interface AdminEmailActivateForm {
  uid: number;
  email: string;
  /** The raw "1"/"0" form values (a junk value is the handler's 400 arm). */
  primary: string | null;
  activate: string | null;
}

export function parseAdminEmailActivateForm(form: URLSearchParams): AdminEmailActivateForm {
  return {
    uid: Number.parseInt(form.get("uid") ?? "0", 10) || 0,
    email: form.get("email") ?? "",
    primary: form.get("primary"),
    activate: form.get("activate"),
  };
}

export type AdminEmailActivateOutcome = "updated" | "no-such-email" | "duplicate-active" | "no-op";

/** The emails.go:106-109 bind arm — uid/email present and both booleans
 *  well-formed, else the handler's 400. */
export function adminEmailActivateFormValid(form: AdminEmailActivateForm): boolean {
  return form.uid !== 0 && form.email !== "" && (form.primary === "1" || form.primary === "0") && (form.activate === "1" || form.activate === "0");
}

/**
 * ActivateEmail → ActivateUserEmail (email_address.go:399-449) minus the
 * unreachable primary-sync arm: the (uid, lower_email) row lookup, the
 * already-in-state no-op, the IsEmailActive duplicate probe on activate
 * (another active row with the address, or another ACTIVE user whose
 * users.email equals it), then the is_activated update. The outcome maps the
 * handler's flash arms — all answered by the caller's 303 (the header's
 * no-flash reduction).
 */
export async function applyAdminEmailActivate(
  d1: D1Database,
  form: AdminEmailActivateForm,
): Promise<AdminEmailActivateOutcome> {
  const activate = form.activate === "1";
  const db = drizzle(d1);
  const lower = form.email.toLowerCase();
  const row = (
    await db
      .select()
      .from(emailAddresses)
      .where(and(eq(emailAddresses.userId, form.uid), eq(emailAddresses.lowerEmail, lower)))
      .limit(1)
      .all()
  )[0];
  if (row === undefined) return "no-such-email"; // "no such email: %d (%s)"
  if (row.isActivated === activate) return "no-op"; // the already-in-state arm

  if (activate) {
    // IsEmailActive (email_address.go:isActiveByEmail minus this row): any
    // OTHER active row with the address, or any OTHER active user's
    // users.email — ErrEmailAlreadyUsed → "duplicate_active".
    const otherRow = (
      await db
        .select({ id: emailAddresses.id })
        .from(emailAddresses)
        .where(and(eq(emailAddresses.lowerEmail, lower), eq(emailAddresses.isActivated, true), ne(emailAddresses.id, row.id)))
        .limit(1)
        .all()
    )[0];
    if (otherRow !== undefined) return "duplicate-active";
    const otherUser = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(and(sql`lower(${users.email}) = ${lower}`, eq(users.status, "active"), ne(users.id, form.uid)))
        .limit(1)
        .all()
    )[0];
    if (otherUser !== undefined) return "duplicate-active";
  }

  await db.update(emailAddresses).set({ isActivated: activate }).where(eq(emailAddresses.id, row.id));
  return "updated";
}

export interface AdminEmailDeleteForm {
  uid: number;
  id: number;
}

export function parseAdminEmailDeleteForm(form: URLSearchParams): AdminEmailDeleteForm {
  return {
    uid: Number.parseInt(form.get("uid") ?? "0", 10) || 0,
    id: Number.parseInt(form.get("id") ?? "0", 10) || 0,
  };
}

export type AdminEmailDeleteOutcome = "deleted" | "miss" | "primary";

/**
 * DeleteEmail (emails.go:158-187): the (uid, id) row lookup — upstream
 * ServerErrors both misses; a stale form here takes the silent-303 arm (the
 * keys-page posture) — then the is_primary guard (unreachable in this store,
 * kept as the honest arm) and the delete.
 */
export async function applyAdminEmailDelete(d1: D1Database, form: AdminEmailDeleteForm): Promise<AdminEmailDeleteOutcome> {
  const db = drizzle(d1);
  const row = (
    await db
      .select()
      .from(emailAddresses)
      .where(and(eq(emailAddresses.id, form.id), eq(emailAddresses.userId, form.uid)))
      .limit(1)
      .all()
  )[0];
  if (row === undefined) return "miss";
  if (row.isPrimary) return "primary"; // delete_primary_email_error (unreachable)
  await db.delete(emailAddresses).where(eq(emailAddresses.id, row.id));
  return "deleted";
}

// ---------------------------------------------------------------------------
// The render (templates/admin/emails/list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The check/x cell (list.tmpl:48's Iif pair) — octicon-check is allowlisted;
 *  octicon-x embeds the submodule bytes (the admin-users FOLD_SVG precedent,
 *  reusing the family's exported table). */
function EmailCheckCell(props: { on: boolean }) {
  return props.on ? <Icon name="octicon-check" /> : <AdminEmbeddedSvg name="octicon-x" />;
}

/** The full-document render (the render.tsx pattern). `doerId` rides the
 *  LOADER (the CanChange formula's input, collapsed in the store — the
 *  module header); the render needs no caller state beyond the data. */
export function renderAdminEmailsPage(ctx: UiContext, data: AdminEmailsData): string {
  return renderPage(<AdminEmailsPage ctx={ctx} data={data} />);
}

/** The admin emails page (§2.4.1 discriminator: `admin user` — the
 *  template's own dict, list.tmpl:1; upstream Title is ctx.Tr "admin.emails"). */
export function AdminEmailsPage(props: { ctx: UiContext; data: AdminEmailsData }) {
  const { params } = props.data;
  const colCount = 6;
  const sortHref = (sort: AdminEmailSort): string => {
    // The dropdown links carry ?sort=&q= only (list.tmpl:16-19's exact shape
    // — the filter params do NOT ride the sort menu).
    const next = new URLSearchParams();
    if (sort !== "email") next.set("sort", sort);
    if (params.keyword !== "") next.set("q", params.keyword);
    const qs = next.toString();
    return qs === "" ? "/-/admin/emails" : `/-/admin/emails?${qs}`;
  };
  // The POST redirect's preserved param set (emails.go:126-141) rides
  // props.data.query — the handlers append page only through the pager's
  // own builder, so the render needs no closure here.
  return (
    <AdminFamilyShell
      ctx={props.ctx}
      title={adminEmailsLocale.email_manage_panel}
      pageClass="admin user"
      active="emails"
    >
      {/* The header (list.tmpl:3-6): panel name + total. */}
      <h4 class="ui top attached header">
        {adminEmailsLocale.email_manage_panel} ({adminEmailsLocale.total.replace("%d", String(props.data.total))})
      </h4>
      {/* The toolbar (list.tmpl:7-33): ONE no-JS GET form wrapping the search
          combo + the sort dropdown's link menu (upstream's <a> items — the
          href carries sort + q only). */}
      <div class="ui attached segment">
        <form class="ui form ignore-dirty flex-text-block" id="email-list-search-form" method="get" action="/-/admin/emails">
          <div class="tw-flex-1">
            <div class="ui small fluid action input">
              <input
                type="search"
                name="q"
                value={params.keyword}
                maxlength={255}
                spellcheck={false}
                placeholder={adminEmailsLocale.search_placeholder}
              />
              <button type="submit" class="ui small icon button" aria-label={adminEmailsLocale.search}>
                {adminEmailsLocale.search}
              </button>
            </div>
          </div>
          <details class="item">
            <summary>{adminEmailsLocale.sort}</summary>
            <div class="menu">
              <a class={params.sort === "email" ? "active item" : "item"} href={sortHref("email")}>
                {adminEmailsLocale.sort_email}
              </a>
              <a class={params.sort === "reverseemail" ? "active item" : "item"} href={sortHref("reverseemail")}>
                {adminEmailsLocale.sort_email_reverse}
              </a>
              <a class={params.sort === "username" ? "active item" : "item"} href={sortHref("username")}>
                {adminEmailsLocale.sort_name}
              </a>
              <a class={params.sort === "reverseusername" ? "active item" : "item"} href={sortHref("reverseusername")}>
                {adminEmailsLocale.sort_name_reverse}
              </a>
            </div>
          </details>
        </form>
      </div>
      {/* The table (list.tmpl:34-84) — the six columns; the sortable headers
          are the tablesort.ts link reduction (the admin-users SortHeader). */}
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          <thead>
            <tr>
              <th scope="col">
                <SortHeader
                  label={adminEmailsLocale.col_name}
                  asc="username"
                  desc="reverseusername"
                  active={params.sort}
                  explicit={params.sort !== "email"}
                  buildHref={(sort) => sortHref(sort as AdminEmailSort)}
                />
              </th>
              <th scope="col">{adminEmailsLocale.col_full_name}</th>
              <th scope="col">
                <SortHeader
                  label={adminEmailsLocale.col_email}
                  asc="email"
                  desc="reverseemail"
                  active={params.sort}
                  explicit={params.sort !== "email"}
                  defaultColumn={true}
                  buildHref={(sort) => sortHref(sort as AdminEmailSort)}
                />
              </th>
              <th scope="col">{adminEmailsLocale.col_primary}</th>
              <th scope="col">{adminEmailsLocale.col_activated}</th>
              <th scope="col">{/* the actions column — list.tmpl:41's empty th */}</th>
            </tr>
          </thead>
          <tbody>
            {props.data.items.length === 0 ? (
              <tr class="no-results-row">
                <td class="tw-text-center" colspan={colCount}>
                  {adminEmailsLocale.no_results}
                </td>
              </tr>
            ) : (
              props.data.items.map((entry) => (
                <tr key={`${entry.userId}-${entry.email}`}>
                  <td>
                    <a href={`/${entry.username}`}>{entry.username}</a>
                  </td>
                  <td class="gt-ellipsis tw-max-w-48">{entry.fullName}</td>
                  <td class="gt-ellipsis tw-max-w-48">{entry.email}</td>
                  <td>
                    <EmailCheckCell on={entry.isPrimary} />
                  </td>
                  <td>
                    {entry.canChange ? (
                      // The change-email arm as the plain-form POST (the
                      // no-JS modal reduction — the module header): the four
                      // upstream form fields plus the state-preservation
                      // hidden inputs (list.tmpl:87-90's set).
                      <form method="post" action="/-/admin/emails/activate" class="tw-inline">
                        <input type="hidden" name="uid" value={String(entry.userId)} />
                        <input type="hidden" name="email" value={entry.email} />
                        <input type="hidden" name="primary" value={entry.isPrimary ? "1" : "0"} />
                        <input type="hidden" name="activate" value={entry.isActivated ? "0" : "1"} />
                        {params.isPrimary !== null ? <input type="hidden" name="is_primary" value={params.isPrimary} /> : null}
                        {params.isActivated !== null ? <input type="hidden" name="is_activated" value={params.isActivated} /> : null}
                        <button type="submit" class="tw-inline" aria-label={adminEmailsLocale.change_email_aria}>
                          <EmailCheckCell on={entry.isActivated} />
                        </button>
                      </form>
                    ) : (
                      <EmailCheckCell on={entry.isActivated} />
                    )}
                  </td>
                  {/* The delete arm — real rows only (a synthesized primary
                      has no row to delete; the header's note). */}
                  <td>
                    {entry.id !== null ? (
                      <form method="post" action="/-/admin/emails/delete" class="tw-inline">
                        <input type="hidden" name="uid" value={String(entry.userId)} />
                        <input type="hidden" name="id" value={String(entry.id)} />
                        <button type="submit" class="tw-text-red link-action negative" aria-label={adminEmailsLocale.delete_email_aria}>
                          <Icon name="octicon-trash" />
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AdminFamilyPagination basePath="/-/admin/emails" query={props.data.query} page={params.page} more={props.data.more} />
    </AdminFamilyShell>
  );
}
