/**
 * The ADMIN PACKAGES list page — `/-/admin/packages` — the survey tick-18's
 * open issue 3 (the last admin-family row beside the auths omission): the
 * admin twin of the R04 packages list (pages/packages.tsx, landed 470e946)
 * over the LANDED model service's admin read (services/packages/model.ts
 * `searchVersions` — the exact function the API's adminListPackages op rides,
 * api/routes/packages.ts:770-521, landed 8cdf44a — never a self-fetch).
 *
 * ## Upstream surface (at the pin fc4936884584)
 *
 * `templates/admin/packages/list.tmpl` served by `admin.Packages`
 * (routers/web/admin/packages.go:20-83), route `GET /-/admin/packages`
 * (web.go:821-827's `/packages` group: the list GET + the two write POSTs,
 * the whole group wrapped in upstream's `packagesEnabled` global-setting
 * qualifier), behind the shared admin gate (web.go:748's
 * verifyAuthWithOptionsWeb{SignInRequired, AdminRequired} — anonymous → the
 * login redirect, a signed-in non-admin → the 404 shell; the ROUTE stage's
 * posture, the landed adminPagePrologue).
 *
 * The handler's data pull (packages.go:23-83): `page`/`q`/`type`/`sort` form
 * reads, `packages_model.SearchVersions` with `IsInternal: Some(false)` and
 * page size `setting.UI.PackagesPagingNum` = 20 (modules/setting/ui.go:94 —
 * the R04 list's page size, NOT the admin family's 50), then
 * `GetPackageDescriptors`, `GetTotalBlobSize` +
 * `GetTotalUnreferencedBlobSize` (package_blob.go:110-123) for the header's
 * two size totals (displayed as `TotalBlobSize - TotalUnreferencedBlobSize`
 * and the raw unreferenced figure), Title = `packages.title`.
 *
 * ## Row projection (list.tmpl:30-77 at the pin → the landed columns)
 *
 *   ID          package_versions.id (the version row's id, like upstream's
 *               `.Version.ID`)
 *   Owner       the owner's user row → /{username} + the gold octicon-lock
 *               when the owner's visibility is private (admin/shared/
 *               owner.tmpl — the admin-repos Owner cell's exact rule; the
 *               lock bytes ride admin-users.tsx's embedded-icon seam)
 *   Type        `Package.Type.Name` (the TypeList display name — the R04
 *               filter census's names, one census two consumers)
 *   Name        `.Package.Name` — PLAIN text (the admin table does not link
 *               the name; the version link is the row's anchor)
 *   Version     `.Version.Version` → the VersionWebLink
 *               (descriptor.go:86-88 — /{owner}/-/packages/{type}/{lowerName}/
 *               {lowerVersion}, PathEscape per segment — the landed
 *               versionWebLink)
 *   Creator     `.Creator.Name` → HomeLink (descriptor.go's Creator load).
 *               An UNATTRIBUTED version (creator_id 0 — the M1 API's
 *               documented null-creator divergence; upstream falls back to
 *               NewGhostUser, descriptor.go:143-150) renders the EMPTY cell:
 *               upstream's Ghost anchor targets /.ghost — no landed page (and
 *               no real upstream page either), the dead-link rule, the R04
 *               by-arm's documented posture reshaped for the column
 *   Repository  `.Repository.Name` → `.Repository.Link` when the package is
 *               linked (the bare slug as the text, /{ownerNamespace}/{slug}
 *               as the href — Repository.Name/Link's exact data). The admin
 *               scope renders EVERY linked repo: the descriptor loads the
 *               repository unconditionally when RepoID > 0 (descriptor.go:
 *               132-137 — no visibility ladder; a missing repo row degrades
 *               to nil upstream and to the empty cell here), the site-admin
 *               page's own shape
 *   Size        `CalculateBlobSize` (descriptor.go:90-94 — the summed file
 *               blob bytes) → FormatByteSize
 *   Published   `DateUtils.AbsoluteShort .Version.CreatedUnix` — the en-US
 *               "Jan 02, 2006" form (the R04 view sidebar's absoluteShort,
 *               imported from pages/packages.tsx)
 *   Op          LIVE (B-67) — the red trash opens upstream's
 *               #admin-package-delete-modal dialog (list.tmpl:70-74 + :86-94,
 *               a bare Yes/No confirm — NO typed name gate) posting
 *               `/-/admin/packages/delete?id=N` (packages.go:82-96). The
 *               no-JS reduction is the admin-repos Op column's inline
 *               plain-form POST (the same template family's landed shape):
 *               hidden `id`, the trash submits, the dialog drops.
 *
 * ## The write tails (B-67 — web.go:823-827's POST pair, POST-only)
 *
 *   - POST /-/admin/packages/delete — admin.DeletePackageVersion
 *     (packages.go:82-96): the version by `id` (ctx.FormInt64 — form body
 *     or query; the modal travels in the query), then RemovePackageVersion.
 *     PORT over the LANDED `deletePackageVersionGuarded`
 *     (ui/pages/package-settings.tsx — a503a02's WB26 seam: the terraform
 *     LOCKED/LATEST guards precede the delete cascade, then
 *     `emitPackageDeleted` fires ONE deleted event, user/package.go:504 /
 *     packages.go:537's always-notify, the ADMIN doer as sender). Upstream's
 *     error arms (a missing/stale id, a guard refusal — both ServerError
 *     500) ride the admin-repos delete's stale-form posture: the seam maps
 *     them to outcomes and the route answers the SAME silent 303. NOTE the
 *     pin's admin surface carries NO whole-package delete arm — upstream's
 *     whole-package delete is the OWNER-scope settings page only
 *     (applyPackageSettingsDelete stays there; the derivation at the pin).
 *   - POST /-/admin/packages/cleanup — admin.CleanupExpiredData
 *     (packages.go:98-110): `CleanupExpiredData(ctx, time.Duration(0))` —
 *     the expired-data sweep ONLY (upstream's admin button does NOT run
 *     ExecuteCleanupRules; that half of CleanupTask is the cron's). PORT as
 *     the module-local sweep `applyAdminPackagesCleanup` over the LANDED
 *     model exports (findUnreferencedPackages → the package properties +
 *     rows, then findExpiredUnreferencedBlobs at olderThan=0 → the rows,
 *     then the R2 content keys — services/packages/cleanup.ts arm 2's exact
 *     order), mirroring the module-local blob-size aggregates' data-seam
 *     note. Success answers the plain redirect upstream takes (ctx.Redirect
 *     — a browser 303 onto /-/admin/packages); a sweep throw propagates
 *     (upstream's ServerError arm, the cleanup consumer's fail-loud
 *     posture). Upstream's `container_service.Cleanup` rides the same
 *     expired-unreferenced-blob state through the container registry's view;
 *     this tree's single package_blobs store makes the generic sweep THAT
 *     sweep (the structural reduction, recorded).
 *
 * ## Derived no-op: no admin version/files detail view
 *
 * Upstream's admin package family registers NO version/files view — the
 * list's Version anchor targets the OWNER-scope view
 * (/{owner}/-/packages/{type}/{name}/{version}, the landed
 * `versionWebLink`); admin/packages.go carries only the three handlers
 * above. There is no admin-package-detail page to land at this pin.
 *
 * ## The sort headers' degradation (the documented no-backing posture)
 *
 * Upstream's table carries the tablesort.ts data-sortt arms — name_asc/
 * name_desc, version_desc/version_asc, created_asc/created_desc
 * (package_version.go:180-194's VersionSort census, configureOrderBy's
 * switch :279-295, the created-desc default). The landed `searchVersions`
 * pins created_unix DESC, id DESC (model.ts — §5.7's insertion-recency
 * order) and exposes NO sort arm; the API's adminListPackages accepts
 * page/limit/type/q only (routes/packages.ts listQuery). A header link
 * would promise an order the data path cannot serve → all four render as
 * PLAIN headers, no anchor, no arrow (the admin-users Last Sign-In
 * header's exact posture). When the service grows the sort parameter the
 * headers light up with the upstream vocabulary unchanged.
 *
 * ## Data (§3.2 — the landed service, never a self-fetch)
 *
 * The rows ride `searchVersions` (services/packages/model.ts) with the
 * admin scope: NO ownerId (upstream's PackageSearchOptions carries no
 * OwnerID on this page — every owner's rows), `excludeInternal: true`
 * (upstream's IsInternal: Some(false)), the q → lower-name LIKE facet and
 * the type facet exactly as the API op passes them. NOTE the list-shape
 * divergence from the R04 twin: the admin page lists VERSIONS
 * (SearchVersions — a package with three versions renders three rows),
 * not the latest-version-per-package projection (SearchLatestVersions)
 * the owner list renders — upstream's own split, package.go:23 vs
 * packages.go:29-34. The header's two blob-size totals have NO landed
 * service arm → module-local parameterized Drizzle aggregates (the
 * admin-users module-local query pattern: this module is the data seam
 * for those two scalars until service arms are extracted; the ROW reads
 * never leave the service).
 *
 * ## Route gate
 *
 * Upstream wraps the whole /packages group in `packagesEnabled` (the
 * global setting) — disabled → the group is unregistered → 404. The landed
 * reduction reads the strict-polarity `PACKAGES_ENABLED` var through
 * ctx.packagesEnabled (armed by resolveUiSession for every page): false →
 * the 404 shell (the R04 prologue's gate arm verbatim). The nav item
 * (AdminFamilyNav's Assets group, upstream navbar.tmpl's
 * `{{if .EnablePackages}}` arm) hides under the same flag.
 *
 * Locale values are upstream's en-US dictionary (the submodule checkout
 * ships no locale files — crowdin-fetched at build; the keys are cited
 * from the templates, the values from upstream's en-US corpus, the
 * admin-users.tsx precedent).
 */

import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { packageBlobs, packageFiles, packageProperties, packageVersions, packages as packagesTable, repositories, users } from "../../db/schema";
import { packageBlobContentKey } from "../../services/packages/blobs";
import {
  PropertyType,
  deleteBlobById,
  findExpiredUnreferencedBlobs,
  findUnreferencedPackages,
  searchVersions,
  type PackageRow,
  type PackageVersionRow,
} from "../../services/packages/model";
import { deletePackageVersionGuarded } from "./package-settings";
import { userLink } from "../links";
import { formatByteSize, parsePageNumber } from "../page-data";
import { Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { PackageDeleteEmitOptions } from "../../services/packages/webhooks";
import { AdminEmbeddedSvg, AdminFamilyPagination, AdminFamilyShell } from "./admin-users";
// The R04 module's shared census + formatters (exports only — that file is
// not this wave's): the type filter's TypeList, the display-name mapping,
// the page size, the version link builder and the AbsoluteShort date.
import { PACKAGES_PAGE_SIZE, PACKAGE_TYPES, absoluteShort, packageTypeName, versionWebLink } from "./packages";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values, the module header)
// ---------------------------------------------------------------------------

export const adminPackagesLocale = {
  panel: "Package Management", // "admin.packages.package_manage_panel" (list.tmpl:4)
  total: "Total: %d", // "admin.total" (list.tmpl:4)
  total_size: "Total Size: %s", // "admin.packages.total_size" (list.tmpl:5)
  unreferenced_size: "Unreferenced Size: %s", // "admin.packages.unreferenced_size" (list.tmpl:6)
  cleanup: "Clean up expired data", // "admin.packages.cleanup" (list.tmpl:10, en-US corpus :3174)
  cleanup_success: "Cleaned up expired data successfully", // "admin.packages.cleanup.success" (:3175 — the flash text the bare 303 drops, the no-session-flash convention)
  col_op: "Op.", // "admin.notices.op" (list.tmpl:50 — the Op column, locale :3490)
  op_delete_aria: "Delete version", // "packages.settings.delete.version" (:3728 — the dialog title the trash opens; the admin-repos additive-aria posture)
  title: "Packages", // "packages.title" (the page Title + the nav item, packages.go:75)
  filter_type: "Type", // "packages.filter.type" (list.tmpl:17)
  filter_type_all: "All", // "packages.filter.type.all" (list.tmpl:18)
  search_placeholder: "Search packages…", // "search.package_kind" (the shared/search/input placeholder)
  search_aria: "Search", // "search.search" (the submit button's aria-label)
  col_id: "ID", // list.tmpl:33
  col_owner: "Owner", // "admin.packages.owner" (list.tmpl:34)
  col_type: "Type", // "admin.packages.type" (list.tmpl:35)
  col_name: "Name", // "admin.packages.name" (list.tmpl:37)
  col_version: "Version", // "admin.packages.version" (list.tmpl:41)
  col_creator: "Creator", // "admin.packages.creator" (list.tmpl:45)
  col_repository: "Repository", // "admin.packages.repository" (list.tmpl:46)
  col_size: "Size", // "admin.packages.size" (list.tmpl:48)
  col_published: "Published", // "admin.packages.published" (list.tmpl:52)
  no_results: "No results found.", // "no_results_found" (list.tmpl:75)
} as const;

/** The type facet's accepted values: "", "all" clear it; anything else rides
 *  the query (an unknown value simply matches nothing — the open string set,
 *  the R04 facet's exact posture). */
function parseTypeFacet(raw: string | null): string {
  return raw ?? "";
}

// ---------------------------------------------------------------------------
// The header's two blob-size totals (module-local aggregates — no service
// arms exist; the module header's data-seam note)
// ---------------------------------------------------------------------------

/** `GetTotalBlobSize` (package_blob.go:110-113) — SUM over every blob row. */
async function totalBlobSizeOf(d1: D1Database): Promise<number> {
  const row = await drizzle(d1)
    .select({ total: sql<number>`coalesce(sum(${packageBlobs.size}), 0)` })
    .from(packageBlobs)
    .all();
  return Number(row[0]?.total ?? 0);
}

/** `GetTotalUnreferencedBlobSize` (package_blob.go:115-123) — the LEFT JOIN
 *  sweep: blobs no package_files row references. */
async function totalUnreferencedBlobSizeOf(d1: D1Database): Promise<number> {
  const row = await drizzle(d1)
    .select({ total: sql<number>`coalesce(sum(${packageBlobs.size}), 0)` })
    .from(packageBlobs)
    .leftJoin(packageFiles, sql`${packageFiles.blobId} = ${packageBlobs.id}`)
    .where(isNull(packageFiles.id))
    .all();
  return Number(row[0]?.total ?? 0);
}

// ---------------------------------------------------------------------------
// The write seams (B-67 — web.go:823-827's POST pair; the module header's
// write-tails section carries the upstream cites and the reductions)
// ---------------------------------------------------------------------------

export type AdminPackageDeleteResult =
  | { outcome: "deleted" }
  | { outcome: "missing" }
  | { outcome: "locked" }
  | { outcome: "latest" };

/**
 * The admin version delete — upstream admin.DeletePackageVersion's ladder
 * (packages.go:82-96) over the LANDED `deletePackageVersionGuarded` (the
 * package-settings seam: the terraform guards precede the cascade, then the
 * deleted-event emission): the version by `id` (upstream ctx.FormInt64 —
 * the form body and the query both bind it; the modal posts it in the
 * query), the package row off the version's packageId (the descriptor's
 * Package arm), the guard-then-delete-then-emit walk. `emit` threads the
 * WB26 options (the ADMIN doer as the sender, packages.go:537's
 * always-notify); a missing/stale id or an unknown shape answers "missing"
 * and a guard refusal its outcome — upstream ServerErrors both arms, the
 * route's stale-form posture folds every outcome onto the same silent 303.
 */
export async function deleteAdminPackageVersionFromForm(
  d1: D1Database,
  rawId: string,
  emit?: PackageDeleteEmitOptions,
): Promise<AdminPackageDeleteResult> {
  const id = /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : 0;
  if (id <= 0) return { outcome: "missing" }; // FormInt64's junk arm — GetVersionByID(0) errors upstream
  const version = (await drizzle(d1).select().from(packageVersions).where(eq(packageVersions.id, id)).get()) ?? null;
  if (version === null) return { outcome: "missing" }; // upstream's GetVersionByID ServerError arm
  const pkg = (await drizzle(d1).select().from(packagesTable).where(eq(packagesTable.id, version.packageId)).get()) ?? null;
  if (pkg === null) return { outcome: "missing" }; // the descriptor's Package load arm
  const guard = await deletePackageVersionGuarded(d1, pkg, version, emit);
  return guard === "ok" ? { outcome: "deleted" } : { outcome: guard };
}

/**
 * The admin cleanup — upstream admin.CleanupExpiredData's sweep
 * (packages.go:98-110 → cleanup.go:169-216 at `olderThan = 0`), the
 * expired-data arm ONLY (ExecuteCleanupRules is the cron's half of
 * CleanupTask — the admin button never runs it). The module-local
 * data-seam note applies: this walks the LANDED model exports in
 * services/packages/cleanup.ts arm 2's exact order —
 *   (a) the unreferenced package rows (zero versions left): the
 *       package-scoped properties, then the row;
 *   (b) EVERY unreferenced blob (olderThan 0 expires all): the rows first,
 *       then the R2 content keys — the SOLE content-key deleter contract.
 * Upstream's `container_service.Cleanup` walks the same expired-
 * unreferenced-blob state through the container registry's view; this
 * tree's single package_blobs store makes step (b) THAT sweep (the
 * structural reduction, recorded). The orphan-spool sweep stays the
 * queue consumer's §5.1 arm — the admin button never had it. A throw
 * propagates (upstream's ServerError arm; the consumer's fail-loud
 * posture — the sweeps re-derive idempotently on a retry).
 */
export async function applyAdminPackagesCleanup(d1: D1Database, bucket: R2Bucket, options: { now?: Date } = {}): Promise<void> {
  const now = options.now ?? new Date();
  const db = drizzle(d1);

  // (a) the unreferenced package rows (cleanup.go:183-191's FindUnreferencedPackages
  // loop — DeleteAllProperties(Package) + DeletePackageByID).
  const unreferenced = await findUnreferencedPackages(d1);
  for (const pkg of unreferenced) {
    await db
      .delete(packageProperties)
      .where(and(eq(packageProperties.refType, PropertyType.Package), eq(packageProperties.refId, pkg.id)))
      .run();
    await db.delete(packagesTable).where(eq(packagesTable.id, pkg.id)).run();
  }

  // (b) the expired unreferenced blobs at olderThan = 0 (cleanup.go:190-214):
  // the rows first, then the content keys — the PACKAGE-DEFER-STORAGE-DELETE
  // order both implementations share.
  const expiredBlobs = await findExpiredUnreferencedBlobs(d1, now);
  for (const blob of expiredBlobs) {
    await deleteBlobById(d1, blob.id);
  }
  for (const blob of expiredBlobs) {
    await bucket.delete(packageBlobContentKey(blob.hashSha256));
  }
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/** One rendered row (list.tmpl:41-73's `<tr>` inputs). */
export interface AdminPackagesListItem {
  version: PackageVersionRow;
  pkg: PackageRow;
  /** The owner's display username (the HomeLink arm). */
  ownerName: string;
  /** The gold lock arm (admin/shared/owner.tmpl — private visibility only). */
  ownerPrivate: boolean;
  /** The creator's display username; null = unattributed (creator_id 0 —
   *  the module header's empty-cell rule). */
  creatorName: string | null;
  /** The linked repo (the bare slug + its /{namespace}/{slug} href); null =
   *  an unlinked package or a repo row gone (descriptor.go's nil arm). */
  repository: { link: string; name: string } | null;
  /** CalculateBlobSize, formatted (the Size cell). */
  sizeText: string;
}

/** The page's render inputs. */
export interface AdminPackagesData {
  items: AdminPackagesListItem[];
  /** The SearchVersions count (the header's Total + the pager's bound). */
  total: number;
  /** `TotalBlobSize - TotalUnreferencedBlobSize`, formatted (packages.go:70). */
  totalSizeText: string;
  /** The raw unreferenced figure, formatted (packages.go:71). */
  totalUnreferencedSizeText: string;
  page: number;
  more: boolean;
  /** The q facet's echoed value (the search input's value arm). */
  query: string;
  typeFilter: string;
  /** The pager's param set (q + type, page excluded — base/paginate keeps
   *  the active facets). */
  pagerQuery: URLSearchParams;
  /** The shell's Integrations gate (admin navbar.tmpl:50-77's reduced
   *  `.EnableOAuth2` wrap, the shell's pass-through prop): threaded by the
   *  loader's optional-trailing-param (the applications loader's shape —
   *  the route passes `oauth2FeatureEnabled(c.env)`). Absent/true = enabled. */
  oauth2Enabled?: boolean;
}

/**
 * The list load (`admin.Packages`, packages.go:23-83): one page of VERSION
 * rows through the LANDED `searchVersions` (the service function the API's
 * adminListPackages op rides — no ownerId, internal rows pinned out, the
 * q + type facets), the batched owner/creator/repo enrichment (the wave-2
 * batching pattern), and the two module-local blob-size totals.
 */
export async function loadAdminPackagesData(d1: D1Database, search: URLSearchParams, oauth2Enabled = true): Promise<AdminPackagesData> {
  const page = parsePageNumber(search.get("page"));
  const query = (search.get("q") ?? "").trim();
  const typeFilter = parseTypeFacet(search.get("type"));

  const [{ rows, count }, blobSize, unreferencedSize] = await Promise.all([
    searchVersions(d1, {
      type: typeFilter !== "" && typeFilter !== "all" ? typeFilter : undefined,
      name: query !== "" ? query : undefined,
      excludeInternal: true,
      page,
      limit: PACKAGES_PAGE_SIZE,
    }),
    totalBlobSizeOf(d1),
    totalUnreferencedBlobSizeOf(d1),
  ]);

  const ownerIds = [...new Set(rows.map((row) => row.pkg.ownerId))];
  const creatorIds = [...new Set(rows.map((row) => row.version.creatorId).filter((id) => id > 0))];
  const repoIds = [...new Set(rows.map((row) => row.pkg.repoId).filter((id): id is string => id !== null))];

  const [ownerRows, creatorRows, repoRows] = await Promise.all([
    ownerIds.length > 0
      ? drizzle(d1).select({ id: users.id, username: users.username, visibility: users.visibility }).from(users).where(inArray(users.id, ownerIds)).all()
      : Promise.resolve([] as { id: number; username: string; visibility: "public" | "limited" | "private" }[]),
    creatorIds.length > 0
      ? drizzle(d1).select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, creatorIds)).all()
      : Promise.resolve([] as { id: number; username: string }[]),
    repoIds.length > 0
      ? drizzle(d1).select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, slug: repositories.slug }).from(repositories).where(inArray(repositories.id, repoIds)).all()
      : Promise.resolve([] as { id: string; ownerNamespace: string; slug: string }[]),
  ]);
  const owners = new Map(ownerRows.map((row) => [row.id, row]));
  const creators = new Map(creatorRows.map((row) => [row.id, row.username]));
  const reposById = new Map(repoRows.map((row) => [row.id, row]));

  // CalculateBlobSize per row (descriptor.go:90-94) as ONE grouped files+
  // blobs read over the page's version ids (getPackageDescriptor per row
  // would N+1; a version with no files sums to nothing — the absent group).
  const versionIds = rows.map((row) => row.version.id);
  const sizeRows =
    versionIds.length > 0
      ? await drizzle(d1)
          .select({ versionId: packageFiles.versionId, total: sql<number>`coalesce(sum(${packageBlobs.size}), 0)` })
          .from(packageFiles)
          .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
          .where(inArray(packageFiles.versionId, versionIds))
          .groupBy(packageFiles.versionId)
          .all()
      : [];
  const sizesByVersion = new Map(sizeRows.map((row) => [row.versionId, Number(row.total)]));

  const items: AdminPackagesListItem[] = rows.map(({ version, pkg }) => {
    const owner = owners.get(pkg.ownerId);
    const repo = pkg.repoId === null ? undefined : reposById.get(pkg.repoId);
    return {
      version,
      pkg,
      // An owner row deleted mid-render: upstream's descriptor load would
      // error the page; the landed skip keeps the honest row-less cell data
      // out (the API op's ownerRow === null continue, routes/packages.ts:512).
      ownerName: owner?.username ?? String(pkg.ownerId),
      ownerPrivate: owner?.visibility === "private",
      creatorName: creators.get(version.creatorId) ?? null,
      repository:
        repo === undefined
          ? null
          : { link: `/${repo.ownerNamespace}/${repo.slug}`, name: repo.slug },
      sizeText: formatByteSize(sizesByVersion.get(version.id) ?? 0),
    };
  });

  const pagerQuery = new URLSearchParams();
  if (query !== "") pagerQuery.set("q", query);
  if (typeFilter !== "") pagerQuery.set("type", typeFilter);

  return {
    items,
    total: count,
    totalSizeText: formatByteSize(blobSize - unreferencedSize),
    totalUnreferencedSizeText: formatByteSize(unreferencedSize),
    page,
    more: page * PACKAGES_PAGE_SIZE < count,
    query,
    typeFilter,
    pagerQuery,
    oauth2Enabled,
  };
}

// ---------------------------------------------------------------------------
// The render (templates/admin/packages/list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderAdminPackagesPage(ctx: UiContext, data: AdminPackagesData): string {
  return renderPage(<AdminPackagesPage ctx={ctx} data={data} />);
}

/** The admin packages page (layout_head's pageClass "admin user" — the
 *  template's literal dict, upstream's own copy-paste; the Title is
 *  ctx.Tr "packages.title", packages.go:75). */
export function AdminPackagesPage(props: { ctx: UiContext; data: AdminPackagesData }) {
  const { data } = props;
  const colCount = 10; // the nine live columns + the Op column (the delete form)
  const base = "/-/admin/packages";
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminPackagesLocale.title} pageClass="admin user" active="packages" oauth2Enabled={props.data.oauth2Enabled}>
      {/* The header (list.tmpl:3-12): panel name + the total + the two size
          totals, and the right-floating Cleanup form — the plain POST to
          /-/admin/packages/cleanup (list.tmpl:8-10; the dialog-less write,
          the registration's bare-303 answer). */}
      <h4 class="ui top attached header">
        {adminPackagesLocale.panel} ({adminPackagesLocale.total.replace("%d", String(data.total))},{" "}
        {adminPackagesLocale.total_size.replace("%s", data.totalSizeText)},{" "}
        {adminPackagesLocale.unreferenced_size.replace("%s", data.totalUnreferencedSizeText)})
        <div class="ui right">
          <form method="post" action="/-/admin/packages/cleanup">
            <button type="submit" class="ui primary tiny button">
              {adminPackagesLocale.cleanup}
            </button>
          </form>
        </div>
      </h4>
      {/* The filter form (list.tmpl:14-29): the q input + the type select
          over AvailableTypes — rendered UNCONDITIONALLY (the admin template
          has no HasPackages gate, unlike the R04 list). */}
      <div class="ui attached segment">
        <form class="ui form ignore-dirty" method="get" action={base}>
          <div class="ui small fluid action input">
            <input
              type="search"
              name="q"
              value={data.query}
              maxLength={255}
              spellcheck={false}
              placeholder={adminPackagesLocale.search_placeholder}
            />
            <select class="ui small dropdown" name="type" aria-label={adminPackagesLocale.filter_type}>
              <option value="">{adminPackagesLocale.filter_type}</option>
              <option value="all" selected={data.typeFilter === "all"}>
                {adminPackagesLocale.filter_type_all}
              </option>
              {PACKAGE_TYPES.map((entry) => (
                <option value={entry.type} selected={data.typeFilter === entry.type}>
                  {entry.name}
                </option>
              ))}
            </select>
            <button type="submit" class="ui small icon button" aria-label={adminPackagesLocale.search_aria}>
              <Icon name="octicon-search" />
            </button>
          </div>
        </form>
      </div>
      {/* The table (list.tmpl:30-77) — the nine live columns. The four
          upstream-sortable headers (name/version/created pairs + their
          SortArrows) render as PLAIN headers: the landed searchVersions has
          no sort arm (the module header's degradation). */}
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          <thead>
            <tr>
              <th scope="col">{adminPackagesLocale.col_id}</th>
              <th scope="col">{adminPackagesLocale.col_owner}</th>
              <th scope="col">{adminPackagesLocale.col_type}</th>
              <th scope="col">{adminPackagesLocale.col_name}</th>
              <th scope="col">{adminPackagesLocale.col_version}</th>
              <th scope="col">{adminPackagesLocale.col_creator}</th>
              <th scope="col">{adminPackagesLocale.col_repository}</th>
              <th scope="col">{adminPackagesLocale.col_size}</th>
              <th scope="col">{adminPackagesLocale.col_published}</th>
              <th scope="col">{adminPackagesLocale.col_op}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td class="tw-text-center" colspan={colCount}>
                  {adminPackagesLocale.no_results}
                </td>
              </tr>
            ) : (
              data.items.map((item) => (
                <tr key={item.version.id}>
                  <td>{item.version.id}</td>
                  <td>
                    <a class="tw-break-anywhere" href={userLink(item.ownerName)}>
                      {item.ownerName}
                    </a>
                    {item.ownerPrivate ? <AdminEmbeddedSvg name="octicon-lock" /> : null}
                  </td>
                  <td>{packageTypeName(item.pkg.type)}</td>
                  <td class="gt-ellipsis tw-max-w-48">{item.pkg.name}</td>
                  <td class="gt-ellipsis tw-max-w-48">
                    <a href={versionWebLink(item.ownerName, item.pkg.type, item.pkg.lowerName, item.version.lowerVersion)}>
                      {item.version.version}
                    </a>
                  </td>
                  <td>
                    {item.creatorName !== null ? <a href={userLink(item.creatorName)}>{item.creatorName}</a> : null}
                  </td>
                  <td>
                    {item.repository !== null ? <a href={item.repository.link}>{item.repository.name}</a> : null}
                  </td>
                  <td>{item.sizeText}</td>
                  <td>{absoluteShort(item.version.createdUnix)}</td>
                  {/* The Op cell (list.tmpl:69-74): the red trash opening the
                      delete dialog upstream — the no-JS plain-form POST
                      reduction (the admin-repos Op column's shape), the
                      registration live behind it. Upstream travels the id in
                      the modal's action URL (?id=N); the hidden field posts
                      it in the body — the route binds both. */}
                  <td>
                    <form method="post" action="/-/admin/packages/delete" class="tw-inline">
                      <input type="hidden" name="id" value={item.version.id} />
                      <button type="submit" class="tw-text-red link-action negative" aria-label={adminPackagesLocale.op_delete_aria}>
                        <Icon name="octicon-trash" />
                      </button>
                    </form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AdminFamilyPagination basePath={base} query={data.pagerQuery} page={data.page} more={data.more} />
    </AdminFamilyShell>
  );
}
