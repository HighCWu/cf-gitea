/**
 * The ADMIN NOTICES page — `/-/admin/notices` — SPEC-0018 §3.1 (the census
 * R18/R20 notices arm, BUILD verdict): the route lives in `index.ts`'s admin
 * literal family block beside the landed R18 arms (the mount record below).
 * This module owns the notices page family only; the store seam is
 * services/notices.ts and the emitter is the repo-tasks DLQ consumer
 * (repos/dlq.ts).
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/notice.tmpl` served by `admin.Notices`
 * (routers/web/admin/notice.go:24-43), route `GET /-/admin/notices`
 * (web.go:882-886's `/notices` group `m.Get("")`), behind
 * `verifyAuthWithOptionsWeb(SignInRequired + AdminRequired)` (web.go:777-779)
 * — the shared adminPagePrologue's exact posture (anonymous → the login 303,
 * a signed-in non-admin → the 404 shell). The group's writes:
 * `m.Post("/delete", admin.DeleteNotices)` (notice.go:46-63 — `ids[]`,
 * non-numeric/non-positive entries ignored) and `m.Post("/empty",
 * admin.EmptyNotices)` (notice.go:66-75 — the bare `DELETE FROM notice`).
 * BOTH LANDED here as the plain-form-POST arms.
 *
 * THERE IS NO CREATE FORM upstream and none here — notices are
 * SYSTEM-generated only (the SPEC §2.2 correction of the census's "admin
 * writes" sketch): upstream's emitters are repo-subsystem failure paths and
 * cron task outcomes; ours is the DLQ consumer (§3.1's emit seam — the
 * SPEC's actual contribution). The emit-vs-retry rule (§5.1) keeps the
 * retrying catch arms notice-free: only TERMINAL (dead-lettered) failures
 * emit.
 *
 * ## The read (notice.go:24-43 over services/notices.ts)
 *
 * Title = "admin.notices" ("System Notices" — the nav label), the panel
 * header = "admin.notices.system_notice_list" + "admin.total", the paged read
 * 25 per page (`setting.UI.Admin.NoticePagingNum`, notice.go:82-88) ordered
 * `created_unix DESC` with our `id DESC` tiebreak (§5.7 — a same-second DLQ
 * batch keeps insertion order), `page` from the query (the shared
 * parsePageNumber floor), the pager (base/paginate's landed reduction).
 *
 * ## Row projection (notice.tmpl:13-31 at the pin → the landed columns)
 *
 *   (checkbox)   the per-row `ids[]` checkbox — upstream's JS-built delete
 *                request, reduced to ONE form wrapping the table (below)
 *   ID           notice id (notice.tmpl:22)
 *   Type         the localized type label — `admin.notices.type_%d`
 *                (notice.go:41-43): 1 = "Repository", 2 = "Task" — plain
 *                text, exactly upstream's render (no badge styling upstream)
 *   Description  the RENDERED one-liner (notice.tmpl:24) — full text, no
 *                truncation (upstream ellipsizes via CSS with the full text
 *                in the DOM)
 *   Created      `DateUtils.AbsoluteShort` (notice.tmpl:25 — the
 *                formatAdminDate twin)
 *   Op.          upstream's cell is a JS modal trigger
 *                (`<a href="#">{{svg "octicon-note"}}</a>`,
 *                notice.tmpl:26) with NO no-JS analog — the description cell
 *                already carries the full content, so the icon renders here
 *                as the INERT marker (title'd span, never a dead link — the
 *                dashboard's "as a note, never as buttons" idiom)
 *
 * The tfoot arms (notice.tmpl:36-54) reduce to the no-JS form pair: ONE form
 * wrapping the table posting `ids[]` to /-/admin/notices/delete with the
 * delete-selected submit, and the red delete-all form beside it (nested
 * forms are illegal HTML — the pair sits in one row below the table,
 * mirroring the tfoot's layout). Per §5.8 BOTH forms render unconditionally
 * — deleting an empty set is a no-op success (§5.4: the delete arm answers
 * the re-render-with-flash even when the id set is empty-after-filter).
 *
 * ## The writes (§3.1 — the no-JS re-render idiom)
 *
 * Upstream's delete answers flash + 200 (notice.go:56-62) and empty answers
 * flash + redirect (:73-74); with no session-flash queue both reduce here to
 * the admin-dashboard's re-render idiom: fresh load + the
 * "admin.notices.delete_success" flash at 200 (the SPEC §3.1 table's
 * "re-render with flash" for BOTH arms; the empty arm's redirect target is
 * the same page, so the re-render IS its reduction).
 *
 * ## Mount record (MOUNTED this unit — the route is live)
 *
 * Route table (`index.ts`), beside the landed adminPagePrologue arms:
 *
 *   GET  /-/admin/notices         adminPagePrologue → loadAdminNoticesData →
 *                                 renderAdminNoticesPage at 200
 *   POST /-/admin/notices/delete  sameOriginGuard + prologue → the §5.4
 *                                 ids[] filter → deleteNoticesByIds → the
 *                                 re-render with the success flash at 200
 *   POST /-/admin/notices/empty   sameOriginGuard + prologue → emptyNotices →
 *                                 the re-render (empty) with the flash at 200
 *
 * The claims sit in the landed admin literal family block
 * (`raw[1] === "-" && raw[2] === "admin"`) — static literals beside the R18
 * arms, ahead of any dynamic arm. The family navbar gains the top-level
 * System Notices item between Integrations and Monitoring (upstream
 * navbar.tmpl:104-106's position — after the Configuration group, before
 * Monitor).
 */

import { parsePageNumber } from "../page-data";
import { renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { AdminFamilyPagination, AdminFamilyShell, formatAdminDate } from "./admin-users";
import {
  ADMIN_NOTICES_PAGE_SIZE,
  countNotices,
  listNotices,
  type NoticeRow,
} from "../../services/notices";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminNoticesLocale = {
  notices: "System Notices", // "admin.notices" (the page Title + the nav item)
  systemNoticeList: "System Notices", // "admin.notices.system_notice_list" (notice.tmpl:4)
  total: "Total: %d", // "admin.total" (notice.tmpl:4)
  colId: "ID", // notice.tmpl:16's literal header
  colType: "Type", // "admin.notices.type" (notice.tmpl:17)
  colDescription: "Description", // "admin.notices.desc" (notice.tmpl:18)
  colCreated: "Created", // "admin.users.created" (notice.tmpl:19)
  colOp: "Op.", // "admin.notices.op" (notice.tmpl:20)
  typeRepository: "Repository", // "admin.notices.type_1"
  typeTask: "Task", // "admin.notices.type_2"
  deleteSelected: "Delete Selected", // "admin.notices.delete_selected"
  deleteAll: "Delete All Notices", // "admin.notices.delete_all"
  noResults: "No results found.", // "no_results_found" (notice.tmpl:32)
  deleteSuccess: "The system notices have been deleted.", // "admin.notices.delete_success"
  viewDetailTitle: "View Notice Details", // "admin.notices.view_detail_header" — the inert marker's title
} as const;

/** The type label arm — `Notice.TrStr`'s `admin.notices.type_%d` resolved
 *  against the closed two-value enum (notice.go:41-43): 1 renders
 *  "Repository", anything else "Task" (the enum has exactly two values; the
 *  fallback arm is unreachably defensive). */
export function noticeTypeLabel(type: NoticeRow["type"]): string {
  return type === 1 ? adminNoticesLocale.typeRepository : adminNoticesLocale.typeTask;
}

// ---------------------------------------------------------------------------
// The loader (notice.go:24-43 over services/notices.ts)
// ---------------------------------------------------------------------------

export interface AdminNoticesData {
  total: number;
  page: number;
  more: boolean;
  items: NoticeRow[];
}

export function loadAdminNoticesData(d1: D1Database, search: URLSearchParams): Promise<AdminNoticesData> {
  // The service wraps drizzle internally (the raw-binding convention —
  // callers never pre-wrap, services/notices.ts).
  const page = parsePageNumber(search.get("page"));
  return (async () => {
    const [total, items] = await Promise.all([countNotices(d1), listNotices(d1, page)]);
    return { total, page, more: page * ADMIN_NOTICES_PAGE_SIZE < total, items };
  })();
}

// ---------------------------------------------------------------------------
// The render (templates/admin/notice.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The upstream `octicon-note` bytes (gitea/public/assets/img/svg/ at the
 *  pin) — non-allowlisted, embedded module-locally (the AdminEmbeddedSvg
 *  table is the family's shared file; this page's single icon stays local). */
const NOTE_ICON_PATH =
  "M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0-.25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75m.75 2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5";

/** The Op. cell's inert marker (the header's note — never a dead link).
 *  AdminEmbeddedSvg falls through to the shared Icon renderer only for
 *  ALLOWLISTED names, and octicon-note is not one — so this page renders
 *  its pinned bytes directly instead of growing the shared table. */
function NoticeDetailMarker() {
  return (
    <span class="view-detail" title={adminNoticesLocale.viewDetailTitle}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" class="svg octicon-note" aria-hidden="true">
        <path d={NOTE_ICON_PATH} />
      </svg>
    </span>
  );
}

/** The full-document render (the render.tsx pattern). `flash` is the POST
 *  arms' re-render banner (the admin-dashboard idiom — see the header). */
export function renderAdminNoticesPage(
  ctx: UiContext,
  data: AdminNoticesData,
  flash: { kind: "positive" | "negative"; text: string } | null = null,
): string {
  return renderPage(<AdminNoticesPage ctx={ctx} data={data} flash={flash} />);
}

/** The admin notices page (§2.4.1 discriminator: `admin notice` — the
 *  template's own dict, notice.tmpl:1; upstream Title is ctx.Tr
 *  "admin.notices"). */
export function AdminNoticesPage(props: {
  ctx: UiContext;
  data: AdminNoticesData;
  flash: { kind: "positive" | "negative"; text: string } | null;
}) {
  const colCount = 6;
  return (
    <AdminFamilyShell
      ctx={props.ctx}
      title={adminNoticesLocale.notices}
      pageClass="admin notice"
      active="notices"
    >
      {/* The header (notice.tmpl:3-5): panel name + total. */}
      <h4 class="ui top attached header">
        {adminNoticesLocale.systemNoticeList} ({adminNoticesLocale.total.replace("%d", String(props.data.total))})
      </h4>
      {props.flash !== null ? (
        <div class={props.flash.kind === "positive" ? "ui positive message" : "ui negative message"}>{props.flash.text}</div>
      ) : null}
      {/* The checkbox table + the delete-selected arm as ONE no-JS form
          (the header's nested-form note); the red delete-all form rides
          beside it — both per §5.8 render unconditionally. */}
      <form method="post" action="/-/admin/notices/delete">
        <div class="ui attached table segment">
          <table class="ui selectable table unstackable">
            <thead>
              <tr>
                <th scope="col">{/* the checkbox column — notice.tmpl:15's empty th */}</th>
                <th scope="col">{adminNoticesLocale.colId}</th>
                <th scope="col">{adminNoticesLocale.colType}</th>
                <th scope="col">{adminNoticesLocale.colDescription}</th>
                <th scope="col">{adminNoticesLocale.colCreated}</th>
                <th scope="col">{adminNoticesLocale.colOp}</th>
              </tr>
            </thead>
            <tbody>
              {props.data.items.length === 0 ? (
                <tr class="no-results-row">
                  <td class="tw-text-center" colspan={colCount}>
                    {adminNoticesLocale.noResults}
                  </td>
                </tr>
              ) : (
                props.data.items.map((notice) => (
                  <tr key={notice.id}>
                    <td>
                      <input type="checkbox" name="ids[]" value={String(notice.id)} aria-label={`${adminNoticesLocale.colId} ${notice.id}`} />
                    </td>
                    <td>{notice.id}</td>
                    <td>{noticeTypeLabel(notice.type)}</td>
                    <td class="view-detail auto-ellipsis tw-w-4/5">
                      <span class="notice-description">{notice.description}</span>
                    </td>
                    <td class="nowrap">{formatAdminDate(notice.createdUnix)}</td>
                    <td>
                      <NoticeDetailMarker />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {/* The tfoot arms (notice.tmpl:36-54) — the delete-selected submit
            of the wrapping form; the red delete-all form beside it (the
            header's no-nesting note). */}
        <div class="tw-flex tw-justify-end tw-gap-2 tw-mt-2">
          <button type="submit" class="ui small button">
            {adminNoticesLocale.deleteSelected}
          </button>
        </div>
      </form>
      <form method="post" action="/-/admin/notices/empty" class="tw-float-right">
        <button type="submit" class="ui red small button">{adminNoticesLocale.deleteAll}</button>
      </form>

      <AdminFamilyPagination basePath="/-/admin/notices" query={new URLSearchParams()} page={props.data.page} more={props.data.more} />
    </AdminFamilyShell>
  );
}
