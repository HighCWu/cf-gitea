/**
 * The ADMIN BADGES family — `/-/admin/badges[...]` — the census R18 (a)
 * badges arm ("the badge CATALOG table is in the schema — its CRUD is
 * upstream web-only, and the admin badges page IS that catalog UI"; the
 * catalog write forms follow the admin-orgs listing shape per the census
 * brief): the routes live in `index.ts`'s admin literal family block. This
 * module owns the badge-catalog UI; the per-user badge API
 * (routes/admin-badges.ts) and the edge store (services/badges.ts) are
 * landed siblings this module CALLS, never edits.
 *
 * ## Upstream surface (at the pin)
 *
 * The `/badges` group (web.go:815-824), gated web.go:779's SignInRequired +
 * AdminRequired (the shared adminPagePrologue posture), seven routes:
 *
 *   GET  /-/admin/badges                        admin.Badges (badges.go:38-50)
 *   GET+POST /-/admin/badges/new                admin.NewBadge / NewBadgePost
 *   GET  /-/admin/badges/slug/{slug}            admin.ViewBadge
 *   GET+POST /-/admin/badges/slug/{slug}/edit   admin.EditBadge / EditBadgePost
 *   POST /-/admin/badges/slug/{slug}/delete     admin.DeleteBadge
 *   GET+POST /-/admin/badges/slug/{slug}/users  admin.BadgeUsers / BadgeUsersPost
 *   POST /-/admin/badges/slug/{slug}/users/delete  admin.DeleteBadgeUser
 *
 * ALL LANDED here — the catalog has no /api/v1 contract upstream (the
 * frozen contract declares none; services/badges.ts's header records the
 * same), so the pages are the contract: templates/admin/badge/{list,new,
 * view,edit,users}.tmpl verbatim at the pin.
 *
 * ## Data (§3.2 — D1 through Drizzle + the landed edge service)
 *
 * The catalog CRUD (CreateBadge/UpdateBadge/DeleteBadge/GetBadge/
 * SearchBadges/GetBadgeUsers, models/user/badge.go) has no landed service —
 * this module issues it directly through Drizzle (the admin-users module-
 * local pattern; the edge reads/writes ride services/badges.ts's exported
 * AddUserBadges/RemoveUserBadges so the API family and this UI share one
 * edge implementation):
 *
 *   list      SearchBadges (badge.go:141-160): the `q` keyword LIKE over
 *             slug (the instr() stand-in), the four sort arms
 *             (RenderBadgeSearch, badges.go:162-200 — oldest id ASC is
 *             BadgeSearchDefaultAdminSort, newest id DESC,
 *             alphabetically/reversealphabetically over slug; junk folds to
 *             oldest), page size `setting.UI.Admin.UserPagingNum` = 50.
 *   create    CreateBadge (badge.go:88-103): the slug-unique pre-check →
 *             "slug_been_taken" (util.ErrAlreadyExist); description and
 *             image_url verbatim (NULLable columns).
 *   update    UpdateBadge (badge.go:118-135's UpdateBadge arm): ONLY
 *             description + image_url are editable — the slug is the
 *             immutable key (edit.tmpl renders the input readonly).
 *   delete    DeleteBadge (badge.go:137-152): the user_badge edges first,
 *             then the badge row.
 *   users     GetBadgeUsers (badge.go:31-36): the INNER JOIN
 *             user_badge → badge → `user` over the slug, paged 50; the
 *             natural FindAndCount order stands in as user_badge.id ASC
 *             (services/badges.ts's getUserBadges convention).
 *   add       BadgeUsersPost (badges.go:228-258): the form's user name
 *             lowercased → GetUserByName (a miss → the "form.user_not_exist"
 *             flash + redirect) → AddUserBadge (the landed service; the
 *             unknown-slug and already-has arms surface as their flash
 *             texts).
 *   remove    DeleteBadgeUser (badges.go:260-285): RemoveUserBadge by the
 *             form's user id + the path slug.
 *
 * ## Write-answer reductions (the no-flash posture)
 *
 * Upstream answers every write with a flash + redirect/JSONRedirect; this
 * family follows the established no-session-flash conventions:
 *   - create/update/edit failures re-render the FULL page at 200 with the
 *     error line + the submitted values (the org-team-new RenderWithErr
 *     arm; upstream JSONErrors);
 *   - create/update successes 303 (create onto the new badge's view page —
 *     upstream's JSONRedirect target, badges.go:80; update onto the same
 *     view, badges.go:128);
 *   - the badge delete and the user add/remove 303 back (the
 *     list/users pages) silently — the flash texts have no renderable
 *     analog (the keys/hooks pages' reduction), and BadgeUsersPost's error
 *     arms re-render the users page with the upstream message line instead
 *     (the one write whose error text is user-actionable: an unknown or
 *     already-badged user).
 *
 * ## Mount record (MOUNTED this wave — the routes are live)
 *
 * All claims sit in the landed admin literal family block (static literals
 * beside users/orgs/repos/emails/hooks; the slug segment is the decoded
 * `{badge_slug}` path param — upstream chi's own param, so the claim is
 * upstream-shaped). The family navbar gains the Badges item (Identity &
 * Access, upstream navbar.tmpl order: badges BEFORE emails).
 */

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { addUserBadges, BadgeNotExistError, removeUserBadges, UserBadgeAlreadyExistsError } from "../../services/badges";
import { badges, userBadges, users } from "../../db/schema";

import { parsePageNumber } from "../page-data";
import type { UiContext } from "../ui-context";
import { AdminFamilyPagination, AdminFamilyShell, SortHeader } from "./admin-users";
import { Icon, renderPage } from "../shell";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminBadgesLocale = {
  badges_manage_panel: "Badge Management", // "admin.badges.badges_manage_panel" (list.tmpl:4)
  total: "Total: %d", // "admin.total" (list.tmpl:4)
  new_badge: "Create New Badge", // "admin.badges.new_badge" (the header button + the new page's title + submit)
  search_placeholder: "Search badges…", // "search.badge_kind" (list.tmpl:14)
  sort: "Sort", // "repo.issues.filter_sort" (list.tmpl:21)
  sort_oldest: "Oldest", // "repo.issues.filter_sort.oldest"
  sort_newest: "Newest", // "repo.issues.filter_sort.latest"
  sort_alphabetically: "Alphabetically", // "repo.issues.label.filter_sort.alphabetically"
  sort_reverse_alphabetically: "Reverse alphabetically", // "repo.issues.label.filter_sort.reverse_alphabetically"
  col_id: "ID", // list.tmpl:40
  col_slug: "Slug", // "admin.badges.slug" (list.tmpl:44)
  col_description: "Description", // "admin.badges.description" (list.tmpl:47)
  details: "Badge Details", // "admin.badges.details" (the star's tooltip/aria)
  edit: "Edit", // "edit" (the pencil's tooltip/aria)
  edit_badge: "Edit Badge", // "admin.badges.edit_badge" (the view page's button + the edit page's title + submit)
  update_badge: "Update Badge", // "admin.badges.update_badge" (edit.tmpl:17)
  delete_badge: "Delete Badge", // "admin.badges.delete_badge" (edit.tmpl:18)
  delete_badge_desc: "Are you sure you want to permanently delete this badge?", // "admin.badges.delete_badge_desc"
  slug_been_taken: "The slug is already taken.", // "admin.badges.slug_been_taken"
  new_success: 'The badge "%s" has been created.', // "admin.badges.new_success" (unused — the silent-303 reduction; kept cited)
  update_success: "The badge has been updated.", // "admin.badges.update_success" (unused — same reduction)
  deletion_success: "The badge has been deleted.", // "admin.badges.deletion_success" (unused — same reduction)
  image_url: "Image URL", // "admin.badges.image_url"
  users: "Users", // "explore.users" (the view page's users header, view.tmpl:26)
  manage_users: "Manage Users", // "admin.badges.manage_users" (view.tmpl:28)
  users_with_badge: "Users with badge: %s", // "admin.badges.users_with_badge" (users.tmpl:3's Title)
  add_user: "Add User", // "admin.badges.add_user" (users.tmpl:10)
  add_user_placeholder: "Search users…", // "search.user_kind" (users.tmpl:8)
  remove_user: "Remove User", // "admin.badges.remove_user" (users.tmpl:26)
  user_not_exist: "The user does not exist.", // "form.user_not_exist" (badges.go:235)
  badge_not_found: "Badge not found.", // "admin.badges.not_found" (badges.go:245)
  user_already_has: "User already has this badge.", // "admin.badges.user_already_has" (badges.go:248)
  user_add_success: "Badge assigned to user successfully.", // "admin.badges.user_add_success" (unused — the re-render carries the fresh list)
  user_remove_success: "Badge removed from user successfully.", // "admin.badges.user_remove_success" (unused — same)
  remove_user_confirm: "Are you sure you want to remove this user from the badge?", // "admin.badges.delete_user_desc" (the remove button's aria — the confirm-dialog reduction)
  required_field: "This field is required.", // the bind-error reduction's generic line (the form's Required binding)
  no_results: "No results found.", // "no_results_found"
} as const;

/** Upstream `setting.UI.Admin.UserPagingNum` (modules/setting/ui.go:138) —
 *  the shared admin page size (badges.go:44,104,166,239). */
export const ADMIN_BADGES_PAGE_SIZE = 50;

/** The four dropdown sorts (badges.go:167-190); the page default is "oldest"
 *  (BadgeSearchDefaultAdminSort, badges.go:27). */
export type AdminBadgeSort = "oldest" | "newest" | "alphabetically" | "reversealphabetically";

/** RenderBadgeSearch's switch — junk folds onto "oldest" (the default arm
 *  also rewrites SortType, badges.go:186-189). */
export function parseAdminBadgeSort(raw: string | null): AdminBadgeSort {
  switch (raw) {
    case "newest":
    case "alphabetically":
    case "reversealphabetically":
      return raw;
    default:
      return "oldest";
  }
}

export interface AdminBadgesListParams {
  keyword: string;
  sort: AdminBadgeSort;
  page: number;
}

export function parseAdminBadgesListParams(params: URLSearchParams): AdminBadgesListParams {
  return {
    keyword: (params.get("q") ?? "").trim(),
    sort: parseAdminBadgeSort(params.get("sort")),
    page: parsePageNumber(params.get("page")),
  };
}

// ---------------------------------------------------------------------------
// Catalog reads (models/user/badge.go — the module header's §Data note)
// ---------------------------------------------------------------------------

export type BadgeCatalogRow = typeof badges.$inferSelect;

/** The page's render inputs (the list template's model). */
export interface AdminBadgesData {
  params: AdminBadgesListParams;
  query: URLSearchParams;
  total: number;
  more: boolean;
  items: BadgeCatalogRow[];
}

/**
 * The list load — Badges → RenderBadgeSearch → SearchBadges: the slug
 * keyword (the instr() stand-in), the four sorts (id/slug ASC-DESC pairs),
 * one page of 50.
 */
export async function loadAdminBadgesData(d1: D1Database, search: URLSearchParams): Promise<AdminBadgesData> {
  const params = parseAdminBadgesListParams(search);
  const conditions: SQL[] = [];
  if (params.keyword !== "") {
    const keyword = params.keyword.toLowerCase();
    conditions.push(sql`instr(lower(${badges.slug}), ${keyword}) > 0`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const orderBy =
    params.sort === "newest"
      ? [desc(badges.id)]
      : params.sort === "alphabetically"
        ? [asc(badges.slug)]
        : params.sort === "reversealphabetically"
          ? [desc(badges.slug)]
          : [asc(badges.id)];

  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(badges).where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const items = await db
    .select()
    .from(badges)
    .where(where)
    .orderBy(...orderBy)
    .limit(ADMIN_BADGES_PAGE_SIZE)
    .offset((params.page - 1) * ADMIN_BADGES_PAGE_SIZE);

  const query = new URLSearchParams();
  if (params.keyword !== "") query.set("q", params.keyword);
  if (params.sort !== "oldest") query.set("sort", params.sort);

  return { params, query, total, more: params.page * ADMIN_BADGES_PAGE_SIZE < total, items };
}

/** GetBadge (badge.go GetBadge by slug) — null on the miss (the caller 303s
 *  back to the list like prepareBadgeInfo's ErrNotExist arm, badges.go:84-92). */
export async function getBadgeBySlug(d1: D1Database, slug: string): Promise<BadgeCatalogRow | null> {
  const row = await drizzle(d1).select().from(badges).where(eq(badges.slug, slug)).limit(1).all();
  return row[0] ?? null;
}

/** GetBadgeUsers (badge.go:31-36) — the paged user join for one slug;
 *  user_badge.id ASC is the natural-order stand-in (the module header). The
 *  rows project the list-render's columns (the name-link reduction — no
 *  avatar pipeline). */
export interface BadgeUserRow {
  id: number;
  username: string;
  fullName: string | null;
  status: "active" | "prohibited";
}

export async function getBadgeUsersPage(
  d1: D1Database,
  slug: string,
  page: number,
): Promise<{ items: BadgeUserRow[]; total: number; more: boolean }> {
  const db = drizzle(d1);
  const where = eq(badges.slug, slug);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(userBadges)
    .innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const items = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      status: users.status,
    })
    .from(userBadges)
    .innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .innerJoin(users, eq(users.id, userBadges.userId))
    .where(where)
    .orderBy(asc(userBadges.id))
    .limit(ADMIN_BADGES_PAGE_SIZE)
    .offset((page - 1) * ADMIN_BADGES_PAGE_SIZE)
    .all();
  return { items, total, more: page * ADMIN_BADGES_PAGE_SIZE < total };
}

// ---------------------------------------------------------------------------
// Catalog writes (CreateBadge / UpdateBadge / DeleteBadge — the §Data note)
// ---------------------------------------------------------------------------

export interface AdminBadgeForm {
  slug: string;
  description: string;
  imageUrl: string;
}

/** The new-badge form bind (forms.AdminCreateBadgeForm's Required slug +
 *  description; image_url optional). */
export function parseAdminBadgeForm(form: URLSearchParams): AdminBadgeForm {
  return {
    slug: (form.get("slug") ?? "").trim(),
    description: (form.get("description") ?? "").trim(),
    imageUrl: (form.get("image_url") ?? "").trim(),
  };
}

export type AdminBadgeCreateOutcome = "created" | "slug-taken" | "invalid";

/** CreateBadge (badge.go:88-103): the required-field bind first, then the
 *  slug-unique pre-check ("slug_been_taken"). */
export async function createBadgeFromForm(d1: D1Database, form: AdminBadgeForm): Promise<AdminBadgeCreateOutcome> {
  if (form.slug === "" || form.description === "") return "invalid";
  const db = drizzle(d1);
  const existing = await db.select({ id: badges.id }).from(badges).where(eq(badges.slug, form.slug)).limit(1).all();
  if (existing.length > 0) return "slug-taken";
  await db.insert(badges).values({
    slug: form.slug,
    description: form.description,
    imageUrl: form.imageUrl === "" ? null : form.imageUrl,
  });
  return "created";
}

export type AdminBadgeUpdateOutcome = "updated" | "invalid";

/** UpdateBadge (badge.go:118-135): description + image_url only — the slug
 *  is the immutable key (edit.tmpl's readonly input). */
export async function updateBadgeFromForm(
  d1: D1Database,
  slug: string,
  form: Pick<AdminBadgeForm, "description" | "imageUrl">,
): Promise<AdminBadgeUpdateOutcome> {
  if (form.description === "") return "invalid";
  await drizzle(d1)
    .update(badges)
    .set({ description: form.description, imageUrl: form.imageUrl === "" ? null : form.imageUrl })
    .where(eq(badges.slug, slug));
  return "updated";
}

/** DeleteBadge (badge.go:137-152): the edges first, then the badge. */
export async function deleteBadgeBySlug(d1: D1Database, slug: string): Promise<boolean> {
  const badge = await getBadgeBySlug(d1, slug);
  if (badge === null) return false;
  const db = drizzle(d1);
  await db.delete(userBadges).where(eq(userBadges.badgeId, badge.id));
  await db.delete(badges).where(eq(badges.id, badge.id));
  return true;
}

// ---------------------------------------------------------------------------
// The user-edge writes (BadgeUsersPost / DeleteBadgeUser over the landed
// services/badges.ts arms — the module header)
// ---------------------------------------------------------------------------

export type AdminBadgeUserAddOutcome = "added" | "user-missing" | "badge-missing" | "already-has";

/** BadgeUsersPost (badges.go:228-258): the lowercased name lookup, then the
 *  landed AddUserBadge (its unknown-slug and already-has errors map to the
 *  upstream flash arms). */
export async function addBadgeUserByName(d1: D1Database, slug: string, rawName: string): Promise<AdminBadgeUserAddOutcome> {
  const name = rawName.trim().toLowerCase();
  if (name === "") return "user-missing";
  const db = drizzle(d1);
  const user = (await db.select().from(users).where(eq(users.usernameLower, name)).limit(1).all())[0];
  if (user === undefined) return "user-missing";
  try {
    await addUserBadges(d1, user.id, [slug]);
  } catch (error) {
    if (error instanceof BadgeNotExistError) return "badge-missing";
    if (error instanceof UserBadgeAlreadyExistsError) return "already-has";
    throw error;
  }
  return "added";
}

/** DeleteBadgeUser (badges.go:260-285): RemoveUserBadge by the form's user
 *  id; unknown slugs absorb silently (the landed service's no-op arm). */
export async function removeBadgeUser(d1: D1Database, slug: string, userId: number): Promise<void> {
  await removeUserBadges(d1, userId, [slug]);
}

/** The edit page's model (edit.tmpl's .Badge). */
export interface AdminBadgeEditData {
  badge: BadgeCatalogRow;
  form: Pick<AdminBadgeForm, "description" | "imageUrl">;
  error: string | null;
}

/** The new page's model (new.tmpl — the submitted values re-render on an
 *  error). */
export interface AdminBadgeNewData {
  form: AdminBadgeForm;
  error: string | null;
}

/** The view page's model (view.tmpl: badge info + the users preview). */
export interface AdminBadgeViewData {
  badge: BadgeCatalogRow;
  usersTotal: number;
  usersPreview: { id: number; username: string }[];
}

/** The users page's model (users.tmpl: the add form + the paged list). */
export interface AdminBadgeUsersData {
  badge: BadgeCatalogRow;
  items: { id: number; username: string; fullName: string | null }[];
  total: number;
  more: boolean;
  page: number;
  query: URLSearchParams;
  error: string | null;
  submittedUser: string;
}

// ---------------------------------------------------------------------------
// The renders (templates/admin/badge/*.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The slug-bearing link builder — PathEscape's encodeURIComponent twin. */
function badgeSlugPath(slug: string, tail = ""): string {
  return `/-/admin/badges/slug/${encodeURIComponent(slug)}${tail}`;
}

/** The full-document render — the list (list.tmpl). */
export function renderAdminBadgesPage(ctx: UiContext, data: AdminBadgesData): string {
  return renderPage(<AdminBadgesPage ctx={ctx} data={data} />);
}

/** The badges list page (§2.4.1 discriminator: `admin badge` — list.tmpl:1;
 *  upstream Title is ctx.Tr "admin.badges"). */
export function AdminBadgesPage(props: { ctx: UiContext; data: AdminBadgesData }) {
  const { params } = props.data;
  return (
    <AdminFamilyShell
      ctx={props.ctx}
      title={adminBadgesLocale.badges_manage_panel}
      pageClass="admin badge"
      active="badges"
    >
      {/* The header (list.tmpl:3-9): panel + total + the Create button (the
          new page is LANDED — a live link). */}
      <h4 class="ui top attached header">
        {adminBadgesLocale.badges_manage_panel} ({adminBadgesLocale.total.replace("%d", String(props.data.total))})
        <div class="ui right">
          <a class="ui primary tiny button" href="/-/admin/badges/new">
            {adminBadgesLocale.new_badge}
          </a>
        </div>
      </h4>
      {/* The toolbar (list.tmpl:11-36): ONE no-JS GET form wrapping the
          search combo + the sort submit-button menu (the admin-users
          reduction). */}
      <div class="ui attached segment">
        <form class="ui form ignore-dirty flex-text-block" id="badge-list-search-form" method="get" action="/-/admin/badges">
          <div class="tw-flex-1">
            <div class="ui small fluid action input">
              <input
                type="search"
                name="q"
                value={params.keyword}
                maxlength={255}
                spellcheck={false}
                placeholder={adminBadgesLocale.search_placeholder}
              />
            </div>
          </div>
          <details class="item">
            <summary>{adminBadgesLocale.sort}</summary>
            <div class="menu">
              <button type="submit" class="item" name="sort" value="oldest">
                {adminBadgesLocale.sort_oldest}
              </button>
              <button type="submit" class="item" name="sort" value="newest">
                {adminBadgesLocale.sort_newest}
              </button>
              <button type="submit" class="item" name="sort" value="alphabetically">
                {adminBadgesLocale.sort_alphabetically}
              </button>
              <button type="submit" class="item" name="sort" value="reversealphabetically">
                {adminBadgesLocale.sort_reverse_alphabetically}
              </button>
            </div>
          </details>
        </form>
      </div>
      {/* The table (list.tmpl:38-66) — the striped four-column shape; the
          star/pencil pair targets the LANDED view/edit pages. */}
      <div class="ui attached table segment">
        <table class="ui very basic striped table unstackable">
          <thead>
            <tr>
              <th scope="col">
                <SortHeader
                  label={adminBadgesLocale.col_id}
                  asc="oldest"
                  desc="newest"
                  active={params.sort}
                  explicit={params.sort !== "oldest"}
                  defaultColumn={true}
                  buildHref={(sort) => {
                    const next = new URLSearchParams(props.data.query);
                    if (sort === "oldest") next.delete("sort");
                    else next.set("sort", sort);
                    const qs = next.toString();
                    return qs === "" ? "/-/admin/badges" : `/-/admin/badges?${qs}`;
                  }}
                />
              </th>
              <th scope="col">
                <SortHeader
                  label={adminBadgesLocale.col_slug}
                  asc="alphabetically"
                  desc="reversealphabetically"
                  active={params.sort}
                  explicit={params.sort !== "oldest"}
                  buildHref={(sort) => {
                    const next = new URLSearchParams(props.data.query);
                    next.set("sort", sort);
                    return `/-/admin/badges?${next.toString()}`;
                  }}
                />
              </th>
              <th scope="col">{adminBadgesLocale.col_description}</th>
              <th scope="col">{/* the actions column — list.tmpl:49's empty th */}</th>
            </tr>
          </thead>
          <tbody>
            {props.data.items.length === 0 ? (
              <tr class="no-results-row">
                <td class="tw-text-center" colspan={4}>
                  {adminBadgesLocale.no_results}
                </td>
              </tr>
            ) : (
              props.data.items.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>
                    <a href={badgeSlugPath(row.slug)}>{row.slug}</a>
                  </td>
                  <td class="gt-ellipsis tw-max-w-48">{row.description ?? ""}</td>
                  <td>
                    <div class="tw-flex tw-gap-2">
                      <a href={badgeSlugPath(row.slug)} data-tooltip-content={adminBadgesLocale.details} aria-label={adminBadgesLocale.details}>
                        <Icon name="octicon-star" />
                      </a>
                      <a
                        href={badgeSlugPath(row.slug, "/edit")}
                        data-tooltip-content={adminBadgesLocale.edit}
                        aria-label={adminBadgesLocale.edit}
                      >
                        <Icon name="octicon-pencil" />
                      </a>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AdminFamilyPagination basePath="/-/admin/badges" query={props.data.query} page={params.page} more={props.data.more} />
    </AdminFamilyShell>
  );
}

/** The full-document render — the new-badge page (new.tmpl). */
export function renderAdminBadgeNewPage(ctx: UiContext, data: AdminBadgeNewData): string {
  return renderPage(<AdminBadgeNewPage ctx={ctx} data={data} />);
}

/** The new badge page (§2.4.1 discriminator: `admin new badge` —
 *  new.tmpl:1). */
export function AdminBadgeNewPage(props: { ctx: UiContext; data: AdminBadgeNewData }) {
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminBadgesLocale.new_badge} pageClass="admin new badge" active="badges">
      <h4 class="ui top attached header">{adminBadgesLocale.new_badge}</h4>
      <div class="ui attached segment">
        {props.data.error !== null ? (
          <div class="ui negative message">
            <p>{props.data.error}</p>
          </div>
        ) : null}
        {/* new.tmpl:7-24's exact field set (slug required, description
            required rows=2, image_url type=url). */}
        <form class="ui form" action="/-/admin/badges/new" method="post">
          <div class="required field">
            <label>{adminBadgesLocale.col_slug}</label>
            <input autofocus required name="slug" value={props.data.form.slug} />
          </div>
          <div class="required field">
            <label>{adminBadgesLocale.col_description}</label>
            <textarea name="description" rows={2} required>
              {props.data.form.description}
            </textarea>
          </div>
          <div class="field">
            <label>{adminBadgesLocale.image_url}</label>
            <input type="url" name="image_url" value={props.data.form.imageUrl} />
          </div>
          <div class="field">
            <button type="submit" class="ui primary button">
              {adminBadgesLocale.new_badge}
            </button>
          </div>
        </form>
      </div>
    </AdminFamilyShell>
  );
}

/** The full-document render — the badge view (view.tmpl). */
export function renderAdminBadgeViewPage(ctx: UiContext, data: AdminBadgeViewData): string {
  return renderPage(<AdminBadgeViewPage ctx={ctx} data={data} />);
}

/** The badge view page (§2.4.1 discriminator: `admin` — view.tmpl carries
 *  the bare dict). */
export function AdminBadgeViewPage(props: { ctx: UiContext; data: AdminBadgeViewData }) {
  const badge = props.data.badge;
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminBadgesLocale.details} pageClass="admin" active="badges">
      {/* view.tmpl's two-section column: the badge info segment with the
          Edit button (the edit page is LANDED — a live link), then the users
          header + Manage Users button (the users page is LANDED). */}
      <h4 class="ui top attached header">
        {badge.slug}
        <div class="ui right">
          <a class="ui primary tiny button" href={badgeSlugPath(badge.slug, "/edit")}>
            {adminBadgesLocale.edit_badge}
          </a>
        </div>
      </h4>
      <div class="ui attached segment">
        <div class="flex-divided-list items-with-main">
          <div class="item">
            {badge.imageUrl !== null && badge.imageUrl !== "" ? (
              <div class="item-leading">
                <img width={64} height={64} src={badge.imageUrl} alt={badge.description ?? ""} title={badge.description ?? ""} />
              </div>
            ) : null}
            <div class="item-main">
              <div class="item-title">{badge.slug}</div>
              <div class="item-body">{badge.description ?? ""}</div>
            </div>
          </div>
        </div>
      </div>
      <h4 class="ui top attached header">
        {adminBadgesLocale.users} ({props.data.usersTotal})
        <div class="ui right">
          <a class="ui primary tiny button" href={badgeSlugPath(badge.slug, "/users")}>
            {adminBadgesLocale.manage_users}
          </a>
        </div>
      </h4>
      <div class="ui attached segment">
        {/* view.tmpl's explore/user_list — the name-link reduction (no
            avatar pipeline, the org-teams precedent). */}
        {props.data.usersPreview.length === 0 ? (
          <div>{adminBadgesLocale.no_results}</div>
        ) : (
          <div class="flex-divided-list">
            {props.data.usersPreview.map((user) => (
              <div class="item" key={user.id}>
                <a href={`/${user.username}`}>{user.username}</a>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminFamilyShell>
  );
}

/** The full-document render — the badge edit page (edit.tmpl). */
export function renderAdminBadgeEditPage(ctx: UiContext, data: AdminBadgeEditData): string {
  return renderPage(<AdminBadgeEditPage ctx={ctx} data={data} />);
}

/** The badge edit page (§2.4.1 discriminator: `admin edit badge` —
 *  edit.tmpl:1). */
export function AdminBadgeEditPage(props: { ctx: UiContext; data: AdminBadgeEditData }) {
  const badge = props.data.badge;
  return (
    <AdminFamilyShell
      ctx={props.ctx}
      title={adminBadgesLocale.edit_badge}
      pageClass="admin edit badge"
      active="badges"
    >
      <h4 class="ui top attached header">{adminBadgesLocale.edit_badge}</h4>
      <div class="ui attached segment">
        {props.data.error !== null ? (
          <div class="ui negative message">
            <p>{props.data.error}</p>
          </div>
        ) : null}
        {/* edit.tmpl:7-19's field set — the slug READONLY (the immutable
            key), description + image_url editable. */}
        <form class="ui form" action={badgeSlugPath(badge.slug, "/edit")} method="post">
          <div class="field">
            <label>{adminBadgesLocale.col_slug}</label>
            <input value={badge.slug} readonly />
          </div>
          <div class="field">
            <label>{adminBadgesLocale.col_description}</label>
            <textarea name="description" rows={2}>
              {props.data.form.description}
            </textarea>
          </div>
          <div class="field">
            <label>{adminBadgesLocale.image_url}</label>
            <input type="url" name="image_url" value={props.data.form.imageUrl} />
          </div>
          <div class="divider"></div>
          <div class="field">
            <button type="submit" class="ui primary button">
              {adminBadgesLocale.update_badge}
            </button>
            {/* edit.tmpl:18-19's red delete button opens the confirm modal
                posting ./delete — the plain-form POST reduction (the
                confirm-dialog reduction). */}
          </div>
        </form>
        <form class="ui form" action={badgeSlugPath(badge.slug, "/delete")} method="post">
          <div class="field">
            <button type="submit" class="ui red button">
              {adminBadgesLocale.delete_badge}
            </button>
            <span class="tw-text-grey">{adminBadgesLocale.delete_badge_desc}</span>
          </div>
        </form>
      </div>
    </AdminFamilyShell>
  );
}

/** The full-document render — the badge users page (users.tmpl). */
export function renderAdminBadgeUsersPage(ctx: UiContext, data: AdminBadgeUsersData): string {
  return renderPage(<AdminBadgeUsersPage ctx={ctx} data={data} />);
}

/** The badge users page (§2.4.1 discriminator: `admin badge` — users.tmpl:1;
 *  upstream Title is users_with_badge over the slug). */
export function AdminBadgeUsersPage(props: { ctx: UiContext; data: AdminBadgeUsersData }) {
  const badge = props.data.badge;
  const usersHref = badgeSlugPath(badge.slug, "/users");
  return (
    <AdminFamilyShell
      ctx={props.ctx}
      title={adminBadgesLocale.users_with_badge.replace("%s", badge.slug)}
      pageClass="admin badge"
      active="badges"
    >
      <h4 class="ui top attached header">{adminBadgesLocale.users_with_badge.replace("%s", badge.slug)}</h4>
      <div class="ui attached segment">
        {props.data.error !== null ? (
          <div class="ui negative message">
            <p>{props.data.error}</p>
          </div>
        ) : null}
        {/* users.tmpl:6-12's add form (the search input + the Add User
            submit) — the no-JS plain POST (upstream's search-user-box JS
            combo reduces to the named input). */}
        <form class="ui form flex-text-block" action={usersHref} method="post">
          <div id="search-user-box" class="ui input">
            <input name="user" placeholder={adminBadgesLocale.add_user_placeholder} autocomplete="off" autofocus required value={props.data.submittedUser} />
          </div>
          <button type="submit" class="ui primary button">
            {adminBadgesLocale.add_user}
          </button>
        </form>
      </div>
      {props.data.items.length > 0 ? (
        <div class="ui attached segment">
          <div class="flex-divided-list items-with-main">
            {props.data.items.map((user) => (
              <div class="item tw-items-center" key={user.id}>
                <div class="item-main">
                  <div class="item-title">
                    <a href={`/${user.username}`}>{user.username}</a>
                  </div>
                </div>
                <div class="item-trailing">
                  {/* users.tmpl:21-27's remove link-action as the plain-form
                      POST (the landed users/delete arm; the confirm-dialog
                      reduction — the desc text rides the aria label). */}
                  <form method="post" action={`${usersHref}/delete`} class="tw-inline">
                    <input type="hidden" name="id" value={String(user.id)} />
                    <button type="submit" class="ui red tiny button inline link-action negative" aria-label={adminBadgesLocale.remove_user_confirm}>
                      {adminBadgesLocale.remove_user}
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <AdminFamilyPagination basePath={usersHref} query={props.data.query} page={props.data.page} more={props.data.more} />
    </AdminFamilyShell>
  );
}
