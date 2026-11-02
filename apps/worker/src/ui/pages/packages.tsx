/**
 * The packages family — SPEC-0016 M2 (the census's R04 + R16 rows, un-deferred
 * by the landed M1 model at 8cdf44a) — over the LANDED package model service
 * (services/packages/model.ts + blobs.ts, never a self-fetch):
 *
 *   GET  /{username}/-/packages                    the owner list (upstream
 *                                                  `user.ListPackages`,
 *                                                  routers/web/user/
 *                                                  package.go:49 — the
 *                                                  latest-version-per-package
 *                                                  rows, ?q/?type filters,
 *                                                  ?page= pager)
 *   GET  /{username}/-/packages/{type}/{name}      303 onto the latest
 *                                                  version's page (upstream
 *                                                  `RedirectToLastVersion`,
 *                                                  package.go:137)
 *   GET  .../{type}/{name}/versions                the version table (upstream
 *                                                  `ListPackageVersions`,
 *                                                  package.go:322 — ?q + the
 *                                                  four sort arms)
 *   GET  .../{type}/{name}/{version}               the version view (upstream
 *                                                  `ViewPackageVersion`,
 *                                                  package.go:188 — the
 *                                                  per-type detail; generic's
 *                                                  install block + the
 *                                                  details/assets/versions
 *                                                  sidebar)
 *   GET  .../{type}/{name}/{version}/files/{id}    the file bytes (upstream
 *                                                  `DownloadPackageFile`,
 *                                                  package.go:530 —
 *                                                  attachment disposition)
 *   GET  /{owner}/{repo}/packages                  the repo tab (upstream
 *                                                  `repo.Packages`,
 *                                                  routers/web/repo/
 *                                                  packages.go:23 — the same
 *                                                  list shape filtered
 *                                                  RepoID)
 *
 * Upstream citations (submodule pin fc4936884584): routers/web/web.go:1106-1128
 * (the R04 group — `context.PackageAssignment()` +
 * `reqPackageAccess(perm.AccessModeRead)` wrap the whole subtree) and
 * web.go:1537-1542 (R16), templates/user/overview/packages.tmpl +
 * package_versions.tmpl + package/shared/{list,versionlist,view,
 * visibility_badge}.tmpl + package/content/generic.tmpl + templates/repo/
 * packages.tmpl, routers/web/user/package.go + routers/web/repo/packages.go.
 *
 * ## Owner resolution + the access gate (web.go:1106's wrap, folded)
 *
 * `resolvePackagesOwner` is the resolveOwnerProjects twin (pages/
 * owner-projects.tsx) with the packages gate: the ORG half first
 * (`resolveOrgHome` — renamed orgs 307, invisible orgs miss), then the USER
 * half (`resolveUserProfile` — the userAssignment + RedirectToUser seam),
 * each admitted row then passing through the LANDED
 * `determinePackageAccessMode` (the M1 port of services/context/package.go:
 * 112-166 with the §4.1 org fold) whose `read` rank gates the whole subtree
 * (upstream reqPackageAccess's mode half — the web UI carries no token, so
 * the scope half is the API family's alone). Anything under read 404-shells,
 * indistinguishable from missing. Two documented landed-ladder arms surface
 * through this gate: a private user's FOLLOWER passes the profile ladder but
 * the service's user arm answers read for public/limited owners only
 * (upstream package.go:157-160's shape — refuses too), and a private org's
 * PLAIN member (no team row) answers none where upstream's
 * HasOrgOrUserVisible arm would read — the landed fold grants through TEAM
 * The plain-member floor CLOSED 2026-10-29 (package.go:155-157 + org.go:458-461 — the membership OR-arm lands read; the matrix pins it).
 * the report.
 *
 * ## The R16 gate (the documented unit-flag reduction)
 *
 * Upstream registers `repo.Packages` whenever the GLOBAL `setting.Packages.
 * Enabled` is on and gates only the header TAB on `CanRead(TypePackages)`.
 * Our substrate carries the per-repo `repo_settings.has_packages` toggle
 * (default false — upstream's own DefaultRepoUnits ships packages disabled;
 * the repo settings checkbox landed with SPEC-0004), so the landed projects
 * precedent applies: `repoPackagesEnabled` (the loadRepoSettings read) gates
 * BOTH the shell tab (shell.tsx, via the ctx `repoHasPackages` member) and
 * the route (the handler's `!== true` 404-shell — the wave-45
 * MustEnableRepoProjects reduction verbatim). The `repo_units` enum gains
 * 'packages' in the same change (ratification 7) for the future per-unit
 * arms; it stays row-less in v1.
 *
 * ## DOM contract
 *
 * The three page classes upstream's templates carry: `user profile packages`
 * (the profile grid — shared/user/profile_big_avatar + user/overview/header
 * + the list), `organization packages` (org/header + org/menu + the list),
 * `repository packages` (repo/header + the list — templates/repo/
 * packages.tmpl). The list block is package/shared/list.tmpl: the filter form
 * (`q` type=search + the `type` select over AvailableTypes + the search
 * button) only when `.HasPackages`, then `.flex-divided-list` rows — the
 * name link to VersionWebLink, the visibility + type labels, the
 * published-by(-in) body — or `.empty-placeholder` (the 48px package glyph +
 * h2 + the repo hint for writers on the repo tab + the documentation line)
 * / the no-result `<p>`. The versions page is package/shared/versionlist.tmpl
 * (the name / Versions breadcrumb, the q + sort form, the version rows). The
 * view is package/shared/view.tmpl: `.issue-title-header` (the
 * `{Name} ({Version})` h1 + badge + published-by), `.packages-content` with
 * the generic install block left (content/generic.tmpl — one curl line per
 * file over `/api/packages/{owner}/generic/...`) and the details segment
 * right (type / repo / calendar / download counter / blob size rows, the
 * Assets list, the Versions sidebar with the View-all link).
 *
 * ## Documented v1 degradations (§6 method — dead links forbidden)
 *
 * - The packages UI WRITE arms are CLAIMED as of this wave (census gap #5):
 *   `POST .../{version}` (PackageVersionDelete, package.go:503), the
 *   settings pair `GET+POST /settings/{type}/{name}` (web.go:1121-1127 →
 *   pages/package-settings.tsx), and the terraform manual lock/unlock POSTs
 *   (web.go:1117-1120 — VERIFIED at the pin: they are the package view's
 *   lock/unlock buttons for terraform-state packages, not a settings
 *   surface). The view renders the write sidebar (Settings anchor + the
 *   delete-version form + the terraform lock-status block) behind
 *   `canWritePackages`; the POST handlers mount through pages/
 *   package-settings.tsx's seams (the module header's mount recipe).
 *   Upstream's `{{if .HasRepositoryAccess}}` issues anchor renders beside
 *   them (the viewer-visible linked repo, the same predicate the
 *   published-by arm reads).
 * - The `/{version_sub}` container arm (web.go:1117's ViewPackageVersion
 *   sub-route) stays unclaimed — container is SPEC-0016 M5's protocol; the
 *   generic view renders one detail shape.
 * - The per-type content/metadata template families (26 content + 22
 *   metadata members at the pin) collapse to the GENERIC pair: v1's only
 *   protocol writes no properties and no metadata (SPEC-0016 §5.4), so the
 *   view renders content/generic + the shared sidebar rows verbatim.
 * - The type badge's `{{svg .Package.Type.SVGName}}` degrades to
 *   `octicon-package` for every type — the ecosystem `gitea-*` glyphs (and
 *   octicon-container) are not in the landed octicon allowlist; the badge's
 *   text carries the type identity. The per-type glyphs arrive with each
 *   ecosystem milestone (the same cadence as their protocols).
 * - The list row's `published_by_in` repo arm renders only when the VIEWER
 *   can see the linked repo (canViewRepositoryWithTeams — upstream
 *   RepositoryAccessMap's GetDoerRepoPermission().HasAnyUnitAccess(), the
 *   visibility reduction); the repo link renders the ownerNamespace/slug.
 * - An unattributed version (creator_id 0 — the M1 API's documented
 *   null-creator divergence) renders "Published {time}" without the by-arm
 *   (no Ghost user page exists — the dead-link rule).
 * - The empty-repo hint (packages.empty.repo) renders its anchor against the
 *   owner's packages list URL — upstream's `{{$packagesUrl := print
 *   .Owner.HomeLink "/-/packages"}}` byte-for-byte (the locale's "package
 *   settings" text predates the settings split at this pin; the href is the
 *   data upstream passes).
 * - The versions sidebar's AbsoluteShort renders the en-US "Jan 02, 2006"
 *   date (ICU-free deterministic bytes — the prettyNumber precedent).
 * - The download serves Last-Modified + attachment disposition with
 *   http.ServeContent's extension-then-sniff content type, no Range and no
 *   ETag (the release-attachment family's streaming reduction — its sniffer,
 *   prefetch split and disposition encoder are REUSED, one port another
 *   consumer); the If-Modified-Since conditional answers 304.
 * - The counter rides OpenBlobForDownload's IsLead gate (packages.go:662-666):
 *   a LEAD file's GET bumps the version's download counter. The generic
 *   protocol never marks files lead, so generic downloads don't bump —
 *   upstream's own shape, not a divergence.
 * - Pagination is PackagesPagingNum = 20 (setting.UI.PackagesPagingNum,
 *   modules/setting/ui.go:94) with the Older/Newer buttons keeping the
 *   active facets (upstream base/paginate preserves the query).
 * - The `type` filter select renders the 23-member TypeList (the model's
 *   open string set — SPEC-0016 §5.9); `all` and the empty value both clear
 *   the facet (the template's `{{if eq $.PackageType $type}}` selected arm).
 * - The strip's ACTIVE posture (the K2 drift adjudication, landed K10):
 *   upstream marks the Packages tab active with `IsPackagesPage` —
 *   package.go:103/:197/:348/:418 set it on every handler of this family,
 *   and user/overview/header.tmpl:23 + org/menu.tmpl:24 test it
 *   (repo/header.tmpl:141 on the repo tab) — NOT `TabName` (profile.go:90
 *   is the whole tree's only TabName setter, fed by the `tab` form value,
 *   never "packages"). With TabName unset the Repositories item renders
 *   INACTIVE on every packages page (header.tmpl:8's
 *   `eq .TabName "repositories"`, menu.tmpl:9's `PageIsViewRepositories`).
 *   The USER arm lands that (`repositoriesActive={false}` on ProfileTabs in
 *   UserProfileGrid + package-settings.tsx); the ORG arm keeps Repositories
 *   ACTIVE — OrgMenu (org-home.tsx, the strip's owner) keys that class on
 *   `projectsTab?.active` and carries no repositories-active control, so
 *   the upstream shape is inexpressible from this consumer. RECORDED
 *   divergence; extending OrgMenu is its owner's change.
 */

import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { isFollowing, listFollowers, listFollowing } from "../../api/services/follows";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { canViewRepositoryWithTeams, type RepositoryRow } from "../../api/services/repository";
import { packageFiles, packageVersions, packages, projects, repositories, users } from "../../db/schema";
import { getBlobById, packageBlobContentKey, type PackageBlobRow } from "../../services/packages/blobs";
import { getTerraformLock, isTerraformLockLocked, type TerraformLockInfo } from "../../services/packages/terraform";
import type { OrgRecord } from "../../services/orgs/orgs";
import type { User as ApiUser } from "../../api/models/user";
import type { Viewer as ApiViewer } from "../../api/services/repository";
import {
  accessModeAtLeast,
  determinePackageAccessMode,
  getPackageByName,
  getPackageDescriptor,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  searchLatestVersions,
  type PackageAccessMode,
  type PackageDoer,
  type PackageFileDescriptor,
  type PackageOwnerRow,
  type PackageRow,
  type PackageVersionRow,
} from "../../services/packages/model";
import { TimeSince } from "../components/file-list";
import { userLink } from "../links";
import { formatByteSize, parsePageNumber, pathEscapeSegments } from "../page-data";
import {
  encodeContentDisposition,
  httpTime,
  SKIP_COMPRESSION_EXTS,
  sniffContentType,
  splitPrefetch,
} from "./release-downloads";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { OrgHeader, OrgMenu, resolveOrgHome } from "./org-home";
import {
  ProfileAvatarCard,
  ProfileTabs,
  resolveUserProfile,
  type ProfileDoer,
  type UserProfileRow,
} from "./user-profile";

// ---------------------------------------------------------------------------
// Chrome text + the type census (component-local locale pattern)
// ---------------------------------------------------------------------------

/** Page chrome text (the tabLocale pattern — upstream locale keys cited). */
export const packagesLocale = {
  title: "Packages", // "packages.title"
  filter_type: "Type", // "packages.filter.type"
  filter_type_all: "All", // "packages.filter.type.all"
  filter_no_result: "Your filter produced no results.", // "packages.filter.no_result"
  empty: "There are no packages yet.", // "packages.empty"
  empty_repo_hint: "Did you upload a package, but it's not shown here? Go to", // "packages.empty.repo" (pre-link)
  empty_repo_hint_link: "package settings", // "packages.empty.repo" (the anchor text)
  empty_repo_hint_tail: "and link it to this repo.", // "packages.empty.repo" (post-link)
  empty_documentation: "For more information on the package registry, see", // "packages.empty.documentation" (pre-link)
  empty_documentation_link: "the documentation", // the shared anchor text
  search_placeholder: "Search packages…", // "search.package_kind"
  search_aria: "Search", // "search.search" (the submit button's aria-label)
  published: "Published", // "packages.published_by" (pre-time)
  by: "by", // the by-arm separator
  in: "in", // "packages.published_by_in"'s repo arm
  versions: "Versions", // "packages.versions"
  versions_view_all: "View all", // "packages.versions.view_all"
  details: "Details", // "packages.details"
  assets: "Assets", // "packages.assets"
  installation: "Installation", // "packages.installation"
  generic_download: "Download package from the command line:", // "packages.generic.download"
  registry_documentation: "For more information on the Generic registry, see", // "packages.registry.documentation" (%s = Generic)
  badge_internal: "Internal", // "repo.desc.internal"
  badge_private: "Private", // "repo.desc.private"
  sort_asc: "A–Z", // "filter.string.asc"
  sort_desc: "Z–A", // "filter.string.desc"
  sort_oldest: "Oldest", // "repo.issues.filter_sort.oldest"
  sort_newest: "Newest", // "repo.issues.filter_sort.latest"
  newer: "Newer", // the pager's label
  older: "Older", // the pager's label
  settings: "Settings", // "repo.settings"
  issues: "Issues", // "repo.issues"
  delete_version: "Delete version", // "packages.settings.delete.version"
  delete_notice_pre: "You are about to delete ", // "packages.settings.delete.notice" (pre-name)
  delete_notice_tail: ". This operation is irreversible, are you sure?", // (post "name (version)")
  modal_yes: "Yes", // "modal.yes" (modal_actions_confirm's default submit)
  terraform_lock_status: "Lock Status", // "packages.terraform.lock_status"
  terraform_unlocked: "Unlocked", // "packages.terraform.unlocked"
  terraform_lock: "Lock", // "packages.terraform.lock"
  terraform_unlock: "Unlock", // "packages.terraform.unlock"
} as const;

/** "packages.terraform.locked_by" — "Locked by %s" (the %s is structural). */
export const TERRAFORM_LOCKED_BY_PREFIX = "Locked by ";

/** The documentation targets (the locale strings' literal hrefs). */
const DOCS_PACKAGES_URL = "https://docs.gitea.com/usage/packages/overview";
const DOCS_GENERIC_URL = "https://docs.gitea.com/usage/packages/generic";

/**
 * Upstream's `TypeList` (models/packages/package.go:55-77) in its exact
 * order, with `Type.Name()` display strings (package.go:81-117). The model's
 * `type` column stays an open string (§5.9) — this list is the FILTER
 * dropdown's census, not a constraint.
 */
export const PACKAGE_TYPES: readonly { type: string; name: string }[] = [
  { type: "alpine", name: "Alpine" },
  { type: "arch", name: "Arch" },
  { type: "cargo", name: "Cargo" },
  { type: "chef", name: "Chef" },
  { type: "composer", name: "Composer" },
  { type: "conan", name: "Conan" },
  { type: "conda", name: "Conda" },
  { type: "container", name: "Container" },
  { type: "cran", name: "CRAN" },
  { type: "debian", name: "Debian" },
  { type: "generic", name: "Generic" },
  { type: "go", name: "Go" },
  { type: "helm", name: "Helm" },
  { type: "maven", name: "Maven" },
  { type: "npm", name: "npm" },
  { type: "nuget", name: "NuGet" },
  { type: "pub", name: "Pub" },
  { type: "pypi", name: "PyPI" },
  { type: "rpm", name: "RPM" },
  { type: "rubygems", name: "RubyGems" },
  { type: "swift", name: "Swift" },
  { type: "terraform", name: "Terraform State" },
  { type: "vagrant", name: "Vagrant" },
];

/** `Type.Name()` for a stored value; unknown values render raw (the open
 *  string set — §5.9). */
export function packageTypeName(type: string): string {
  return PACKAGE_TYPES.find((entry) => entry.type === type)?.name ?? type;
}

/** Upstream `setting.UI.PackagesPagingNum` (modules/setting/ui.go:94). */
export const PACKAGES_PAGE_SIZE = 20;

/** The versions sidebar's page (ViewPackageVersion's SearchVersions 0-5
 *  slice, package.go:266-286). */
const VIEW_SIDEBAR_VERSION_COUNT = 5;

/** The upstream links (descriptor.go:79-92 — PackageWebLink /
 *  VersionWebLink over the LOWER name/version, PathEscape per segment). */
export function packageWebLink(ownerName: string, type: string, lowerName: string): string {
  return `/${ownerName}/-/packages/${type}/${pathEscapeSegments(lowerName)}`;
}

export function versionWebLink(ownerName: string, type: string, lowerName: string, lowerVersion: string): string {
  return `${packageWebLink(ownerName, type, lowerName)}/${pathEscapeSegments(lowerVersion)}`;
}

/** The settings page link (descriptor.go:84-87 — PackageSettingsLink over
 *  the LOWER name, one `/settings` depth above the package link). */
export function packageSettingsLink(ownerName: string, type: string, lowerName: string): string {
  return `/${ownerName}/-/packages/settings/${type}/${pathEscapeSegments(lowerName)}`;
}

/** The download tail (package.go:530's route — `/files/{fileid}`). */
export function packageFileDownloadLink(
  ownerName: string,
  type: string,
  lowerName: string,
  lowerVersion: string,
  fileId: number,
): string {
  return `${versionWebLink(ownerName, type, lowerName, lowerVersion)}/files/${fileId}`;
}

/** The generic registry's install line (content/generic.tmpl — AppFullLink +
 *  `/api/packages/{owner}/generic/{name}/{version}/{filename}`). */
export function genericCurlLine(
  origin: string,
  ownerName: string,
  packageName: string,
  packageVersion: string,
  filename: string,
): string {
  return `curl -OJ ${origin}/api/packages/${ownerName}/generic/${packageName}/${packageVersion}/${filename}`;
}

/** DateUtils.AbsoluteShort ("Jan 02, 2006") — the en-US deterministic form
 *  (the module header's ICU-free note). */
export function absoluteShort(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, "0")}, ${date.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Resolution — the handler-side seam (index.ts calls these; kept here so the
// page module owns its data path, the owner-projects pattern)
// ---------------------------------------------------------------------------

/** The resolution outcome for the R04 subtree — the OWNER union the upstream
 *  handler branches on (`ctx.ContextUser.IsOrganization()`), plus the shared
 *  redirect/miss arms. */
export type OwnerPackagesResolution =
  | { kind: "org"; org: OrgRecord }
  | { kind: "user"; user: UserProfileRow }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the owner for the packages subtree (web.go:1106's
 * `context.PackageAssignment()` + `reqPackageAccess(read)` wrap, folded):
 * the ORG half first (`resolveOrgHome`), then the USER half
 * (`resolveUserProfile`), each admitted row then passing through the LANDED
 * `determinePackageAccessMode` whose `read` rank gates the whole subtree
 * (the module header's gate note). The visibility ladders already ran inside
 * the two halves, so the assignment's `ownerVisibleToDoer` input is true;
 * the service's own ladder then decides owner/org-fold/read — a private
 * user's FOLLOWER passes the profile ladder but still 404s here (the
 * service's user arm answers read for public/limited owners only, upstream
 * package.go:157-160's exact shape).
 */
export async function resolvePackagesOwner(
  d1: D1Database,
  owner: string,
  doer: ProfileDoer,
  requestPath: string,
  requestQuery: string,
): Promise<OwnerPackagesResolution> {
  const org = await resolveOrgHome(d1, owner, doer, requestPath, requestQuery);
  if (org.kind === "redirect") return org;
  if (org.kind === "org") {
    const readable = await ownerPackagesReadable(
      d1,
      { id: org.org.id, type: "org", visibility: org.org.visibility },
      doer,
    );
    return readable ? org : { kind: "missing" };
  }
  const profile = await resolveUserProfile(d1, owner, doer, requestPath, requestQuery);
  if (profile.kind === "redirect") return profile;
  if (profile.kind === "missing") return { kind: "missing" };
  const readable = await ownerPackagesReadable(
    d1,
    { id: profile.user.id, type: "user", visibility: profile.user.visibility },
    doer,
  );
  return readable ? { kind: "user", user: profile.user } : { kind: "missing" };
}

/** The subtree's mode resolution (the group-wrap's `ctx.Package.AccessMode`
 *  value): the LANDED ladder over the admitted owner row (a null doer is the
 *  anonymous arm). The read gate below and this wave's write arms (the
 *  version-delete POST + the settings pair + the terraform lock POSTs —
 *  web.go:1115/1121-1127's `reqPackageAccess(perm.AccessModeWrite)`, whose
 *  `< mode` arm is upstream's 404) all read it. */
export async function ownerPackagesAccessMode(
  d1: D1Database,
  owner: PackageOwnerRow,
  doer: ProfileDoer,
): Promise<PackageAccessMode> {
  const pkgDoer: PackageDoer | null = doer.id === null ? null : { id: doer.id, isAdmin: doer.isAdmin };
  return determinePackageAccessMode(d1, owner, pkgDoer, { ownerVisibleToDoer: true });
}

/** The subtree's read gate — `reqPackageAccess(perm.AccessModeRead)`'s mode
 *  half over the LANDED ladder (a null doer is the anonymous arm). */
async function ownerPackagesReadable(d1: D1Database, owner: PackageOwnerRow, doer: ProfileDoer): Promise<boolean> {
  return accessModeAtLeast(await ownerPackagesAccessMode(d1, owner, doer), "read");
}

/** The R16 gate (the module header's reduction): the repo's
 *  `repo_settings.has_packages` toggle — the shell tab and the route read
 *  the SAME predicate. */
export async function repoPackagesEnabled(d1: D1Database, repoId: string): Promise<boolean> {
  return (await loadRepoSettings(d1, repoId)).hasPackages;
}

// ---------------------------------------------------------------------------
// Shared row enrichment (the descriptors the templates render)
// ---------------------------------------------------------------------------

/** The viewer-visible linked repo (the `published_by_in` arm's data). */
export interface LinkedRepoView {
  /** The `/{namespace}/{slug}` link (Repository.Link). */
  link: string;
  /** The display name (Repository.FullName). */
  fullName: string;
}

/** One rendered LIST row (package/shared/list.tmpl's `.item` inputs). */
export interface PackageListItem {
  pkg: PackageRow;
  version: PackageVersionRow;
  /** Creator display username; null = unattributed (creator_id 0). */
  creatorName: string | null;
  /** The linked repo when the viewer can see it — null = the plain
   *  published_by arm. */
  repository: LinkedRepoView | null;
}

/** The visibility badge kind (package/shared/visibility_badge.tmpl's chain):
 *  a package-internal row wins, then the owner's private/limited arms render
 *  private/internal. Null = no badge (a public package of a public owner). */
export function packageVisibilityBadgeKind(
  pkg: PackageRow,
  ownerVisibility: "public" | "limited" | "private",
): "internal" | "private" | null {
  if (pkg.isInternal) return "internal";
  if (ownerVisibility === "private") return "private";
  if (ownerVisibility === "limited") return "internal";
  return null;
}

/** Batch the creator usernames for one page of versions (the wave-2 batching
 *  pattern; creator_id 0 rows stay null). */
async function creatorNamesOf(d1: D1Database, versionRows: PackageVersionRow[]): Promise<Map<number, string>> {
  const ids = [...new Set(versionRows.map((row) => row.creatorId).filter((id) => id > 0))];
  const names = new Map<number, string>();
  if (ids.length === 0) return names;
  const rows = await drizzle(d1)
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.id, ids))
    .all();
  for (const row of rows) names.set(row.id, row.username);
  return names;
}

/** The service-side identity of the session viewer (the owner-projects
 *  module's conversion — the api Viewer's requester slice the repo-visibility
 *  predicates read). */
function packagesApiUser(viewer: Viewer): ApiUser | null {
  return viewer.kind === "user" ? { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin } : null;
}

/** Resolve the linked-repo views for one page of package rows — the batched
 *  repositories read, each row's visibility against the VIEWER (the module
 *  header's RepositoryAccessMap reduction). */
async function linkedReposOf(
  d1: D1Database,
  rows: PackageRow[],
  viewer: Viewer,
  origin: string,
): Promise<Map<number, LinkedRepoView>> {
  const repoIds = [...new Set(rows.map((row) => row.repoId).filter((id): id is string => id !== null))];
  const views = new Map<number, LinkedRepoView>();
  if (repoIds.length === 0) return views;
  const apiViewer: ApiViewer = { origin, requester: packagesApiUser(viewer) };
  const repoRows = await drizzle(d1).select().from(repositories).where(inArray(repositories.id, repoIds)).all();
  const byId = new Map<string, RepositoryRow>(repoRows.map((row) => [row.id, row]));
  for (const pkg of rows) {
    if (pkg.repoId === null) continue;
    const repo = byId.get(pkg.repoId);
    if (repo === undefined) continue;
    if (!(await canViewRepositoryWithTeams(d1, apiViewer, repo))) continue;
    views.set(pkg.id, {
      link: `/${repo.ownerNamespace}/${repo.slug}`,
      fullName: `${repo.ownerNamespace}/${repo.slug}`,
    });
  }
  return views;
}

/** `HasOwnerPackages` (package.go — the empty arms' decision): ANY package
 *  row for the owner, internal rows included (upstream's HasOwnerPackages
 *  has no IsInternal arm). */
export async function hasOwnerPackages(d1: D1Database, ownerId: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: packages.id })
    .from(packages)
    .where(eq(packages.ownerId, ownerId))
    .limit(1)
    .all();
  return rows.length > 0;
}

/** `HasRepositoryPackages` (package.go:355): ANY package row linked to the
 *  repo. */
export async function hasRepositoryPackages(d1: D1Database, repoId: string): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: packages.id })
    .from(packages)
    .where(eq(packages.repoId, repoId))
    .limit(1)
    .all();
  return rows.length > 0;
}

/** `ExistVersion` (packages.go — PackageVersionDelete's redirect split, :517-520):
 *  whether the package still carries ANY non-internal version — true keeps
 *  the redirect ON the package page, false falls to the owner list. */
export async function hasNonInternalVersion(d1: D1Database, packageId: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.isInternal, false)))
    .limit(1)
    .all();
  return rows.length > 0;
}

/** The chrome the packages pages render beside the profile tabs / org menu
 *  (the loaders' shared read) — exported for pages/package-settings.tsx, the
 *  settings page's chrome. */
export interface PackagesOwnerChrome {
  repoCount: number;
  followers: number;
  following: number;
  /** The USER arm's Projects-tab count (header.tmpl:17-20's
   *  `{{if .ProjectCount}}` label — the OPEN projects total, loadHeaderCount
   *  parity; the ORG arm renders no Projects tab, the count stays its
   *  zero). */
  openProjects: number;
  /** The strip's follow-button input (org/header.tmpl:17 on the ORG arm,
   *  profile_big_avatar.tmpl:123-136 on the USER arm): present only for a
   *  signed-in viewer who is not the owner, IsFollowing(doer, owner) its
   *  label (header.go:28's argument order). */
  followButton: { following: boolean } | null;
  /** profile_big_avatar.tmpl:18's admin gear gate (the viewer's admin
   *  flag; the ORG arm renders no avatar card, the field is inert there). */
  viewerIsAdmin: boolean;
}

/** The chrome counts the packages pages render beside the profile tabs /
 *  org menu (the loaders' shared read) — exported for pages/
 *  package-settings.tsx, the settings page's chrome. */
export async function ownerPackagesChrome(
  d1: D1Database,
  owner: PackagesOwner,
  doer: ProfileDoer,
): Promise<PackagesOwnerChrome> {
  if (owner.kind === "user") return userProfileChrome(d1, owner.user, doer);
  const [repoCount, viewerFollows] = await Promise.all([
    ownerRepoCount(d1, ownerIdOf(owner), doer),
    // org/header.tmpl:17's follow_unfollow include (IsFollowing(doer, org),
    // the org-home loader's gate — a doer row of the org itself cannot
    // exist, the id comparison is the defensive shape).
    doer.id !== null && doer.id !== owner.org.id ? isFollowing(d1, doer.id, owner.org.id) : Promise.resolve(false),
  ]);
  return {
    repoCount,
    followers: 0,
    following: 0,
    openProjects: 0,
    followButton: doer.id !== null && doer.id !== owner.org.id ? { following: viewerFollows } : null,
    viewerIsAdmin: doer.isAdmin,
  };
}

/** The type facet's accepted values (the select's value arm): "", "all"
 *  clear it; anything else rides the query (an unknown value simply matches
 *  nothing — the open string set). */
function parseTypeFacet(raw: string | null): string {
  return raw ?? "";
}

/** The versions page's sort arms (package_version.go:180-186's VersionSort
 *  values the template's select carries; the default is created_desc). */
export type PackageVersionSort = "" | "version_asc" | "version_desc" | "created_asc" | "created_desc";

function parseSortFacet(raw: string | null): PackageVersionSort {
  return raw === "version_asc" || raw === "version_desc" || raw === "created_asc" || raw === "created_desc"
    ? raw
    : "";
}

/** The menu/overview tab's repository count (loadHeaderCount's RepoCount
 *  arm — the profile loader's WHERE: self/admin sees private rows, everyone
 *  else public). */
async function ownerRepoCount(d1: D1Database, ownerId: number, doer: ProfileDoer): Promise<number> {
  const seePrivate = doer.id !== null && (doer.isAdmin || doer.id === ownerId);
  const where = seePrivate
    ? eq(repositories.ownerId, ownerId)
    : and(eq(repositories.ownerId, ownerId), eq(repositories.visibility, "public"));
  const row = await drizzle(d1).select({ total: sql<number>`count(*)` }).from(repositories).where(where).get();
  return Number(row?.total ?? 0);
}

/** The user arm's avatar-card counts (the profile loader's pair — count-only
 *  pages; the numbers are real). */
async function followCountsOf(d1: D1Database, userId: number, doer: ProfileDoer): Promise<{ followers: number; following: number }> {
  const followViewer = { id: doer.id, isAdmin: doer.isAdmin };
  const [followerPage, followingPage] = await Promise.all([
    listFollowers(d1, userId, followViewer, { page: 1, pageSize: 1 }),
    listFollowing(d1, userId, followViewer, { page: 1, pageSize: 1 }),
  ]);
  return { followers: followerPage.total, following: followingPage.total };
}

/** The profile-grid chrome both user-arm pages carry (the avatar card's
 *  counts + the menu's RepoCount — the user-half chrome data), the wave I-b
 *  strip arms included. */
type UserProfileChrome = PackagesOwnerChrome;

async function userProfileChrome(d1: D1Database, user: UserProfileRow, doer: ProfileDoer): Promise<UserProfileChrome> {
  const [repoCount, follows, openProjectsRow, viewerFollows] = await Promise.all([
    ownerRepoCount(d1, user.id, doer),
    followCountsOf(d1, user.id, doer),
    // The strip's Projects count (header.tmpl:17-20 — the OPEN individual
    // projects: the projects.ownerId arm, loadHeaderCount parity).
    drizzle(d1)
      .select({ total: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.ownerId, user.id), eq(projects.isClosed, false)))
      .get(),
    // The avatar card's follow button (profile_big_avatar.tmpl:123-136,
    // IsFollowing(doer, target), header.go:28's argument order).
    doer.id !== null && doer.id !== user.id ? isFollowing(d1, doer.id, user.id) : Promise.resolve(false),
  ]);
  return {
    repoCount,
    followers: follows.followers,
    following: follows.following,
    openProjects: Number(openProjectsRow?.total ?? 0),
    followButton: doer.id !== null && doer.id !== user.id ? { following: viewerFollows } : null,
    viewerIsAdmin: doer.isAdmin,
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** The owner union the loaders take (the resolution's admitted arms). */
export type PackagesOwner = Extract<OwnerPackagesResolution, { kind: "org" | "user" }>;

function ownerIdOf(owner: PackagesOwner): number {
  return owner.kind === "org" ? owner.org.id : owner.user.id;
}

/** The owner's display name segment (both arms' link/anchor inputs) —
 *  exported for pages/package-settings.tsx. */
export function ownerNameOf(owner: PackagesOwner): string {
  return owner.kind === "org" ? owner.org.username : owner.user.username;
}

/** The owner's visibility (the badge chain's input) — exported for pages/
 *  package-settings.tsx. */
export function ownerVisibilityOf(owner: PackagesOwner): "public" | "limited" | "private" {
  return owner.kind === "org" ? owner.org.visibility : owner.user.visibility;
}

/** The latest-version-per-package list read (ListPackages + repo.Packages'
 *  shared shape): the LANDED `searchLatestVersions` with the q (package-name
 *  LIKE) + type facets, internal rows pinned out. */
async function listLatestRows(
  d1: D1Database,
  opts: { ownerId: number; repoId?: string; type?: string; query?: string; page: number },
): Promise<{ rows: { version: PackageVersionRow; pkg: PackageRow }[]; count: number }> {
  return searchLatestVersions(d1, {
    ownerId: opts.ownerId,
    repoId: opts.repoId,
    type: opts.type !== undefined && opts.type !== "" && opts.type !== "all" ? opts.type : undefined,
    name: opts.query !== undefined && opts.query !== "" ? opts.query : undefined,
    excludeInternal: true,
    page: opts.page,
    limit: PACKAGES_PAGE_SIZE,
  });
}

/** The R04 list page's render inputs. */
export interface OwnerPackagesData {
  owner: PackagesOwner;
  items: PackageListItem[];
  total: number;
  page: number;
  more: boolean;
  query: string;
  typeFilter: string;
  /** `HasOwnerPackages` — the filter form renders only when the owner has
   *  ANY packages (upstream's `{{if .HasPackages}}`); the empty arms branch
   *  on it too. */
  hasPackages: boolean;
  /** The menu tab's repository count (loadHeaderCount's RepoCount arm). */
  repoCount: number;
  /** The user arm's avatar-card counts. */
  followers: number;
  following: number;
  /** The USER arm's Projects-tab count (header.tmpl:17-20 — the OPEN
   *  projects total, loadHeaderCount parity). */
  openProjects: number;
  /** The strip's follow button (the user arm's avatar card :123-136, the
   *  org arm's header org/header.tmpl:17). */
  followButton: { following: boolean } | null;
  /** profile_big_avatar.tmpl:18's admin gear gate (the viewer's admin
   *  flag; inert on the ORG arm). */
  viewerIsAdmin: boolean;
}

/**
 * Load the R04 list (ListPackages, package.go:49): one
 * latest-version-per-package page through the LANDED searchLatestVersions
 * (the q → package-name LIKE + type facets, internal rows pinned out —
 * upstream's `IsInternal: optional.Some(false)`), the batched creator +
 * viewer-visible-repo enrichment, `HasOwnerPackages`, and the chrome counts.
 */
export async function loadOwnerPackagesData(
  d1: D1Database,
  owner: PackagesOwner,
  viewer: Viewer,
  origin: string,
  params: URLSearchParams,
): Promise<OwnerPackagesData> {
  const page = parsePageNumber(params.get("page"));
  const query = (params.get("q") ?? "").trim();
  const typeFilter = parseTypeFacet(params.get("type"));
  const doer: ProfileDoer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const ownerId = ownerIdOf(owner);

  const [{ rows, count }, hasPackages, chrome] = await Promise.all([
    listLatestRows(d1, { ownerId, type: typeFilter, query, page }),
    hasOwnerPackages(d1, ownerId),
    ownerPackagesChrome(d1, owner, doer),
  ]);

  const names = await creatorNamesOf(d1, rows.map((row) => row.version));
  const repoViews = await linkedReposOf(d1, rows.map((row) => row.pkg), viewer, origin);
  const items: PackageListItem[] = rows.map(({ version, pkg }) => ({
    pkg,
    version,
    creatorName: names.get(version.creatorId) ?? null,
    repository: repoViews.get(pkg.id) ?? null,
  }));

  return {
    owner,
    items,
    total: count,
    page,
    more: page * PACKAGES_PAGE_SIZE < count,
    query,
    typeFilter,
    hasPackages,
    repoCount: chrome.repoCount,
    followers: chrome.followers,
    following: chrome.following,
    openProjects: chrome.openProjects,
    followButton: chrome.followButton,
    viewerIsAdmin: chrome.viewerIsAdmin,
  };
}

/** The R16 repo tab's render inputs (repo/packages.go:23's shape — the same
 *  list filtered RepoID, plus the writer grant behind the empty hint and the
 *  OWNER visibility the badge chain reads). */
export interface RepoPackagesData {
  /** The display pair the list block's owner name + links render. */
  ownerName: string;
  ownerVisibility: "public" | "limited" | "private";
  items: PackageListItem[];
  total: number;
  page: number;
  more: boolean;
  query: string;
  typeFilter: string;
  /** `HasRepositoryPackages` — the filter-form arm. */
  hasPackages: boolean;
  /** `CanWritePackages` (repo/packages.go:62) — the empty hint's grant (the
   *  landed repo-wide writer reduction). Set by the handler after the load
   *  (the releases canCreate pattern). */
  canWritePackages: boolean;
}

/**
 * Load the R16 tab (repo.Packages, packages.go:23): the SAME list shape with
 * the repo facet added (`RepoID = ctx.Repo.Repository.ID`, :24-33 — the
 * landed searchLatestVersions' repoId arm) over the repo's OWNER id, the
 * owner's visibility read for the badge chain (upstream renders the OWNER
 * user row here), and HasRepositoryPackages (:36-44).
 */
export async function loadRepoPackagesData(
  d1: D1Database,
  repo: Pick<RepoRow, "id" | "ownerNamespace" | "slug" | "ownerId">,
  viewer: Viewer,
  origin: string,
  params: URLSearchParams,
): Promise<RepoPackagesData> {
  const page = parsePageNumber(params.get("page"));
  const query = (params.get("q") ?? "").trim();
  const typeFilter = parseTypeFacet(params.get("type"));

  // An ownerless legacy repo row (the nullable owner_id, SPEC-0003 §3.1) can
  // link no packages — the empty answer without the owner reads.
  if (repo.ownerId === null) {
    return {
      ownerName: repo.ownerNamespace,
      ownerVisibility: "public",
      items: [],
      total: 0,
      page,
      more: false,
      query,
      typeFilter,
      hasPackages: false,
      canWritePackages: false,
    };
  }

  const [{ rows, count }, hasPackages, ownerRow] = await Promise.all([
    listLatestRows(d1, { ownerId: repo.ownerId, repoId: repo.id, type: typeFilter, query, page }),
    hasRepositoryPackages(d1, repo.id),
    drizzle(d1).select({ visibility: users.visibility }).from(users).where(eq(users.id, repo.ownerId)).get(),
  ]);
  const names = await creatorNamesOf(d1, rows.map((row) => row.version));
  const repoViews = await linkedReposOf(d1, rows.map((row) => row.pkg), viewer, origin);
  const items: PackageListItem[] = rows.map(({ version, pkg }) => ({
    pkg,
    version,
    creatorName: names.get(version.creatorId) ?? null,
    repository: repoViews.get(pkg.id) ?? null,
  }));

  return {
    ownerName: repo.ownerNamespace,
    ownerVisibility: ownerRow?.visibility ?? "public",
    items,
    total: count,
    page,
    more: page * PACKAGES_PAGE_SIZE < count,
    query,
    typeFilter,
    hasPackages,
    canWritePackages: false, // the handler sets it (the releases canCreate pattern)
  };
}

/** The versions table's row (package/shared/versionlist.tmpl's `.item`). */
export interface PackageVersionItem {
  version: PackageVersionRow;
  creatorName: string | null;
}

/** The versions page's render inputs (ListPackageVersions, package.go:322). */
export interface OwnerPackageVersionsData {
  owner: PackagesOwner;
  pkg: PackageRow;
  items: PackageVersionItem[];
  total: number;
  page: number;
  more: boolean;
  query: string;
  sort: PackageVersionSort;
  /** The chrome counts (the profile grid / org menu both render them). */
  repoCount: number;
  followers: number;
  following: number;
  /** The USER arm's Projects-tab count (header.tmpl:17-20). */
  openProjects: number;
  /** The strip's follow button (the user arm's avatar card :123-136, the
   *  org arm's header org/header.tmpl:17). */
  followButton: { following: boolean } | null;
  /** profile_big_avatar.tmpl:18's admin gear gate (inert on the ORG arm). */
  viewerIsAdmin: boolean;
}

/**
 * Load the versions table (GetPackageByName + SearchVersions{PackageID,
 * Version ~ q, IsInternal false, Sort}, package.go:322-398): the package row
 * through the LANDED `getPackageByName`, then the joined version page with
 * the version-substring filter and the four `configureOrderBy` arms
 * (package_version.go:280-294 — the landed service's default order is the
 * created DESC arm; the id tiebreak kept verbatim). A package miss is
 * upstream's NotFound.
 */
export async function loadOwnerPackageVersionsData(
  d1: D1Database,
  owner: PackagesOwner,
  viewer: Viewer,
  type: string,
  name: string,
  params: URLSearchParams,
): Promise<OwnerPackageVersionsData | null> {
  const pkg = await getPackageByName(d1, ownerIdOf(owner), type, name);
  if (pkg === null) return null;
  const page = parsePageNumber(params.get("page"));
  const query = (params.get("q") ?? "").trim();
  const sort = parseSortFacet(params.get("sort"));

  const conditions = [eq(packageVersions.packageId, pkg.id), eq(packageVersions.isInternal, false)];
  if (query !== "") conditions.push(like(packageVersions.lowerVersion, `%${query.toLowerCase()}%`));
  const orderBy =
    sort === "version_asc"
      ? [asc(packageVersions.version)]
      : sort === "version_desc"
        ? [desc(packageVersions.version)]
        : sort === "created_asc"
          ? [asc(packageVersions.createdUnix)]
          : [desc(packageVersions.createdUnix)];

  const db = drizzle(d1);
  const rows = await db
    .select({ version: packageVersions })
    .from(packageVersions)
    .where(and(...conditions))
    .orderBy(...orderBy, desc(packageVersions.id))
    .limit(PACKAGES_PAGE_SIZE)
    .offset((page - 1) * PACKAGES_PAGE_SIZE)
    .all();
  const counted = await db
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .where(and(...conditions))
    .all();
  const total = Number(counted[0]?.total ?? 0);
  const versions = rows.map((row) => row.version);
  const names = await creatorNamesOf(d1, versions);

  const doer: ProfileDoer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const chrome = await ownerPackagesChrome(d1, owner, doer);

  return {
    owner,
    pkg,
    items: versions.map((version) => ({ version, creatorName: names.get(version.creatorId) ?? null })),
    total,
    page,
    more: page * PACKAGES_PAGE_SIZE < total,
    query,
    sort,
    repoCount: chrome.repoCount,
    followers: chrome.followers,
    following: chrome.following,
    openProjects: chrome.openProjects,
    followButton: chrome.followButton,
    viewerIsAdmin: chrome.viewerIsAdmin,
  };
}

/** The version view's render inputs (ViewPackageVersion, package.go:188). */
export interface PackageVersionViewData {
  owner: PackagesOwner;
  pkg: PackageRow;
  version: PackageVersionRow;
  /** The version's files with their blobs (the Assets list + size text). */
  files: (PackageFileDescriptor & { sizeText: string })[];
  creatorName: string | null;
  /** The linked repo when the viewer can see it (HasRepositoryAccess — the
   *  module header's reduction). */
  repository: LinkedRepoView | null;
  /** CalculateBlobSize (descriptor.go) — the summed blob bytes, formatted. */
  blobSizeText: string;
  /** The version's download counter (the sidebar's download row). */
  downloadCount: number;
  /** The sidebar's five latest versions + the package's total (the
   *  non-container arm of package.go:266-286). */
  latestVersions: PackageVersionRow[];
  totalVersionCount: number;
  /** The registry host the install lines name (upstream
   *  PackageRegistryHost — GuessCurrentHostURL's host). */
  registryHost: string;
  /** The chrome counts (the profile grid / org menu both render them). */
  repoCount: number;
  followers: number;
  following: number;
  /** The USER arm's Projects-tab count (header.tmpl:17-20). */
  openProjects: number;
  /** The strip's follow button (the user arm's avatar card :123-136, the
   *  org arm's header org/header.tmpl:17). */
  followButton: { following: boolean } | null;
  /** profile_big_avatar.tmpl:18's admin gear gate (inert on the ORG arm). */
  viewerIsAdmin: boolean;
  /** `CanWritePackages` (package.go:306) — the write-mode rank of the SAME
   *  ladder the route gate ran; arms the settings/delete sidebar block and
   *  the terraform lock forms. */
  canWritePackages: boolean;
  /** The terraform specialization's view data (services/packages/terraform/
   *  spec.go:31-55 — GetViewPackageVersionData, reduced): isLatestVersion
   *  + the LOCK when this is the latest version of a terraform package and
   *  it is locked. Both stay at their zero answers for every other type. */
  isLatestVersion: boolean;
  terraformLock: TerraformLockInfo | null;
}

/**
 * Load the version view (GetVersionByNameAndVersion + GetPackageDescriptor +
 * the sidebar read, package.go:188-301): a null answer at either identity
 * hop is upstream's NotFound (files never miss while the version exists —
 * GetFilesAndBlobsByVersionID answers the empty list).
 */
export async function loadOwnerPackageVersionViewData(
  d1: D1Database,
  owner: PackagesOwner,
  viewer: Viewer,
  origin: string,
  type: string,
  name: string,
  version: string,
): Promise<PackageVersionViewData | null> {
  const ownerId = ownerIdOf(owner);
  const pkg = await getPackageByName(d1, ownerId, type, name);
  if (pkg === null) return null;
  const versionRow = await getVersionByNameAndVersion(d1, ownerId, type, name, version);
  if (versionRow === null) return null;
  const descriptor = await getPackageDescriptor(d1, pkg, versionRow);
  const creatorName =
    versionRow.creatorId > 0 ? ((await creatorNamesOf(d1, [versionRow])).get(versionRow.creatorId) ?? null) : null;

  // The sidebar read (package.go:276-286's non-container arm): the package's
  // five newest versions + the total, internal rows pinned out.
  const sidebarWhere = and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.isInternal, false));
  const sidebar = await drizzle(d1)
    .select({ version: packageVersions })
    .from(packageVersions)
    .where(sidebarWhere)
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .limit(VIEW_SIDEBAR_VERSION_COUNT)
    .all();
  const sidebarCount = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .where(sidebarWhere)
    .all();

  let repository: LinkedRepoView | null = null;
  if (pkg.repoId !== null) {
    const repoRow = await drizzle(d1).select().from(repositories).where(eq(repositories.id, pkg.repoId)).get();
    const apiViewer: ApiViewer = { origin, requester: packagesApiUser(viewer) };
    if (repoRow !== undefined && (await canViewRepositoryWithTeams(d1, apiViewer, repoRow))) {
      repository = {
        link: `/${repoRow.ownerNamespace}/${repoRow.slug}`,
        fullName: `${repoRow.ownerNamespace}/${repoRow.slug}`,
      };
    }
  }

  const doer: ProfileDoer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const chrome = await ownerPackagesChrome(d1, owner, doer);

  // The write-mode rank (package.go:306's CanWritePackages — the same
  // determinePackageAccessMode ladder the route gate ran, now at write).
  const canWritePackages = accessModeAtLeast(
    await ownerPackagesAccessMode(
      d1,
      { id: ownerId, type: owner.kind === "org" ? "org" : "user", visibility: ownerVisibilityOf(owner) },
      doer,
    ),
    "write",
  );

  // The terraform specialization's view data (spec.go:31-55, reduced): the
  // latest-version comparison over the SAME SearchLatestVersions arm, then
  // the lock read ONLY when this is the latest version. Other types keep
  // the zero answers (the specialization registers for terraform alone).
  let isLatestVersion = false;
  let terraformLock: TerraformLockInfo | null = null;
  if (pkg.type === "terraform") {
    const latest = await searchLatestVersions(d1, {
      ownerId,
      type: pkg.type,
      name: pkg.lowerName,
      exact: true,
      excludeInternal: true,
      page: 1,
      limit: 1,
    });
    isLatestVersion = latest.rows[0]?.version.id === versionRow.id;
    if (isLatestVersion) {
      const lock = await getTerraformLock(d1, pkg.id);
      if (isTerraformLockLocked(lock)) terraformLock = lock;
    }
  }

  const blobSize = descriptor.files.reduce((sum, file) => sum + file.blob.size, 0);
  return {
    owner,
    pkg,
    version: versionRow,
    files: descriptor.files.map((file) => ({ ...file, sizeText: formatByteSize(file.blob.size) })),
    creatorName,
    repository,
    blobSizeText: formatByteSize(blobSize),
    downloadCount: versionRow.downloadCount,
    latestVersions: sidebar.map((row) => row.version),
    totalVersionCount: Number(sidebarCount[0]?.total ?? 0),
    registryHost: new URL(origin).host,
    repoCount: chrome.repoCount,
    followers: chrome.followers,
    following: chrome.following,
    openProjects: chrome.openProjects,
    followButton: chrome.followButton,
    viewerIsAdmin: chrome.viewerIsAdmin,
    canWritePackages,
    isLatestVersion,
    terraformLock,
  };
}

/** The RedirectToLastVersion arm's resolution (package.go:137-166): the
 *  package's latest non-internal version, or the 404 family when the
 *  package (or every version of it) is gone. The owner's CURRENT display
 *  name rides the users row (HomeLink — a redirect already resolved the
 *  rename by the time this runs). */
export type LatestVersionResolution = { kind: "redirect"; location: string } | { kind: "missing" };

export async function resolveLatestVersionRedirect(
  d1: D1Database,
  ownerId: number,
  type: string,
  name: string,
): Promise<LatestVersionResolution> {
  const pkg = await getPackageByName(d1, ownerId, type, name);
  if (pkg === null) return { kind: "missing" };
  const latest = await searchLatestVersions(d1, {
    ownerId: pkg.ownerId,
    type: pkg.type,
    name: pkg.lowerName,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 1,
  });
  const version = latest.rows[0]?.version;
  if (version === undefined) return { kind: "missing" };
  const ownerRow = await drizzle(d1).select({ username: users.username }).from(users).where(eq(users.id, pkg.ownerId)).get();
  return {
    kind: "redirect",
    location: versionWebLink(ownerRow?.username ?? String(pkg.ownerId), pkg.type, pkg.lowerName, version.lowerVersion),
  };
}

// ---------------------------------------------------------------------------
// The file download (DownloadPackageFile, package.go:530-560)
// ---------------------------------------------------------------------------

/** One download outcome: the opened object (prefetch split for the content
 *  type) or the 404 family (GetFileForVersionByID's ErrPackageFileNotExist +
 *  the missing-object arm). */
export type PackageFileDownload =
  | {
      kind: "serve";
      /** The sniff prefix (≤ 1024 B) — the content type's input; the stream
       *  re-emits everything (splitPrefetch's MultiReader shape). */
      prefix: Uint8Array;
      body: ReadableStream<Uint8Array>;
      /** The R2 object's size (Content-Length). */
      size: number;
      /** The verbatim file name (the disposition's filename). */
      filename: string;
      /** The file row's created_unix (Last-Modified). */
      createdAt: Date;
    }
  | { kind: "not-found" };

/**
 * Open the package file for download (GetFileForVersionByID →
 * OpenFileForDownload, package.go:530-545 + services/packages/packages.go:
 * 628-666): the file row must live under THIS version (the id pair is the
 * arbitration), the blob row answers through GetBlobByID, the object opens
 * from the content-addressed key. The counter rides OpenBlobForDownload's
 * IsLead gate (packages.go:662-666 — a LEAD file's GET bumps it; the generic
 * protocol never marks files lead, so its downloads don't bump, upstream's
 * own shape). A missing object is the honest 404 (the sole-sweeper posture —
 * the same arm the API download runs).
 */
export async function loadPackageFileDownload(
  bucket: R2Bucket,
  d1: D1Database,
  versionId: number,
  fileId: number,
  method: "GET" | "HEAD",
): Promise<PackageFileDownload> {
  // GetFileForVersionByID (package_file.go) — the id pair, not the name.
  const file = (
    await drizzle(d1)
      .select()
      .from(packageFiles)
      .where(and(eq(packageFiles.id, fileId), eq(packageFiles.versionId, versionId)))
      .all()
  )[0];
  if (file === undefined) return { kind: "not-found" };
  const blob: PackageBlobRow | null = await getBlobById(d1, file.blobId);
  if (blob === null) return { kind: "not-found" };
  const object = await bucket.get(packageBlobContentKey(blob.hashSha256));
  if (object === null) return { kind: "not-found" };
  if (file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, versionId);
  }
  const { prefix, rest } = await splitPrefetch(object.body as ReadableStream<Uint8Array>);
  return {
    kind: "serve",
    prefix,
    body: rest,
    size: object.size,
    filename: file.name,
    createdAt: file.createdUnix,
  };
}

/** http.ServeContent's content type (go/src/net/http/fs.go): the extension
 *  table first (mime.TypeByExtension's builtin members a package file
 *  carries), else the sniff over the prefetch (the release-downloads port —
 *  one sniffer, another consumer). */
export function packageFileContentType(filename: string, prefix: Uint8Array): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot < 0 ? "" : filename.slice(dot).toLowerCase();
  const byExtension: Record<string, string> = {
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tgz": "application/gzip",
    ".tar": "application/x-tar",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
    ".xml": "text/xml; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
  };
  const mapped = byExtension[ext];
  return mapped ?? sniffContentType(prefix);
}

/** serve.go:80-89's skip-compression hint predicate (gzhttp's
 *  HeaderNoCompression carries "1"). */
function needsSkipCompressionHint(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  const ext = dot < 0 ? "" : filename.slice(dot).toLowerCase();
  return SKIP_COMPRESSION_EXTS.has(ext);
}

/**
 * The download Response — DownloadPackageFile's serve half (ServeSetHeaders
 * with the ATTACHMENT default + http.ServeContent's extension/sniff content
 * type, module header): nosniff, the encoded attachment disposition, the
 * exposed header, Last-Modified, Content-Length, the skip-compression hint,
 * and the If-Modified-Since 304 arm (http.ServeContent's Last-Modified
 * conditional — no Range, no ETag: the release-attachment reduction).
 */
export function packageFileDownloadResponse(
  serve: Extract<PackageFileDownload, { kind: "serve" }>,
  options: { ifModifiedSince: string | null },
): Response {
  const lastModified = httpTime(serve.createdAt);
  const headers = new Headers();
  headers.set("last-modified", lastModified);
  if (options.ifModifiedSince !== null && options.ifModifiedSince !== "") {
    const since = new Date(options.ifModifiedSince);
    if (
      !Number.isNaN(since.getTime()) &&
      Math.floor(serve.createdAt.getTime() / 1000) <= Math.floor(since.getTime() / 1000)
    ) {
      return new Response(null, { status: 304, headers });
    }
  }
  headers.set("content-type", packageFileContentType(serve.filename, serve.prefix));
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-length", String(serve.size));
  headers.set("content-disposition", encodeContentDisposition("attachment", serve.filename));
  headers.set("access-control-expose-headers", "Content-Disposition");
  if (needsSkipCompressionHint(serve.filename)) headers.set("x-no-compression", "1");
  return new Response(serve.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The pager (base/paginate reduced to the Older/Newer buttons, keeping the
 *  active facets in the query — the issues-list DOM shape). */
function PackagesPagination(props: { base: string; page: number; more: boolean; keep: Record<string, string> }) {
  if (props.page <= 1 && !props.more) return null;
  const hrefFor = (target: number): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(props.keep)) {
      if (value !== "") params.set(key, value);
    }
    if (target > 1) params.set("page", String(target));
    const query = params.toString();
    return query === "" ? props.base : `${props.base}?${query}`;
  };
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={hrefFor(props.page - 1)}>
            <span class="navigation_label">{packagesLocale.newer}</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={hrefFor(props.page + 1)}>
            <span class="navigation_label">{packagesLocale.older}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The visibility badge (package/shared/visibility_badge.tmpl — the
 *  internal/private/limited chain; null renders nothing) — exported for
 *  pages/package-settings.tsx's breadcrumb. */
export function PackageVisibilityBadge(props: { kind: "internal" | "private" | null }) {
  if (props.kind === "internal") return <span class="ui basic label">{packagesLocale.badge_internal}</span>;
  if (props.kind === "private") return <span class="ui basic label">{packagesLocale.badge_private}</span>;
  return null;
}

/** The type label (the `{{svg .Package.Type.SVGName}} {{.Type.Name}}` chip —
 *  the octicon-package degradation, module header). */
function PackageTypeLabel(props: { type: string }) {
  return (
    <span class="ui label">
      <Icon name="octicon-package" /> {packageTypeName(props.type)}
    </span>
  );
}

/** One list row (package/shared/list.tmpl's `.item` — the name link, the
 *  badge pair, the published-by(-in) body). */
function PackageListItemRow(props: {
  item: PackageListItem;
  ownerName: string;
  ownerVisibility: "public" | "limited" | "private";
}) {
  const { pkg, version, creatorName, repository } = props.item;
  return (
    <div class="item">
      <div class="item-main">
        <div class="item-title">
          <a href={versionWebLink(props.ownerName, pkg.type, pkg.lowerName, version.lowerVersion)}>{pkg.name}</a>
          <span class="label-list">
            <PackageVisibilityBadge kind={packageVisibilityBadgeKind(pkg, props.ownerVisibility)} />
            <PackageTypeLabel type={pkg.type} />
          </span>
        </div>
        <div class="item-body">
          {packagesLocale.published}{" "}
          <TimeSince unixSeconds={Math.floor(version.createdUnix.getTime() / 1000)} tz="+0000" />
          {creatorName !== null ? (
            <>
              {" "}
              {packagesLocale.by} <a href={userLink(creatorName)}>{creatorName}</a>
            </>
          ) : null}
          {repository !== null ? (
            <>
              {" "}
              {packagesLocale.in}{" "}
              <a href={repository.link}>
                <strong>{repository.fullName}</strong>
              </a>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The filter form (package/shared/list.tmpl's form for the lists — `q` +
 *  the type select; versionlist.tmpl's variant swaps the select for the four
 *  sort arms). Rendered only when `.HasPackages` on the lists; the versions
 *  form renders unconditionally (upstream's versionlist has no HasPackages
 *  gate). */
function PackagesFilterForm(props: { query: string; typeFilter?: string; sort?: PackageVersionSort; versions?: boolean }) {
  return (
    <form class="ui form ignore-dirty">
      <div class="ui small fluid action input">
        <input type="search" name="q" value={props.query} maxLength={255} spellcheck={false} placeholder={packagesLocale.search_placeholder} />
        {props.versions ? (
          <select class="ui small dropdown" name="sort" aria-label={packagesLocale.versions}>
            <option value="version_asc" selected={props.sort === "version_asc"}>{packagesLocale.sort_asc}</option>
            <option value="version_desc" selected={props.sort === "version_desc"}>{packagesLocale.sort_desc}</option>
            <option value="created_asc" selected={props.sort === "created_asc"}>{packagesLocale.sort_oldest}</option>
            <option value="created_desc" selected={props.sort === undefined || props.sort === "" || props.sort === "created_desc"}>
              {packagesLocale.sort_newest}
            </option>
          </select>
        ) : (
          <select class="ui small dropdown" name="type" aria-label={packagesLocale.filter_type}>
            <option value="">{packagesLocale.filter_type}</option>
            <option value="all" selected={props.typeFilter === "all"}>{packagesLocale.filter_type_all}</option>
            {PACKAGE_TYPES.map((entry) => (
              <option value={entry.type} selected={props.typeFilter === entry.type}>
                {entry.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" class="ui small icon button" aria-label={packagesLocale.search_aria}>
          <Icon name="octicon-search" />
        </button>
      </div>
    </form>
  );
}

/** The empty placeholder (package/shared/list.tmpl's `{{if not .HasPackages}}`
 *  arm — the 48px glyph, the h2, the writer-only repo hint on the repo tab,
 *  the documentation line). */
function PackagesEmptyPlaceholder(props: { repoHint: { ownerPackagesUrl: string } | null }) {
  return (
    <div class="empty-placeholder">
      <Icon name="octicon-package" size={48} />
      <h2>{packagesLocale.empty}</h2>
      {props.repoHint !== null ? (
        <p>
          {packagesLocale.empty_repo_hint}{" "}
          <a href={props.repoHint.ownerPackagesUrl}>{packagesLocale.empty_repo_hint_link}</a>{" "}
          {packagesLocale.empty_repo_hint_tail}
        </p>
      ) : null}
      <p>
        {packagesLocale.empty_documentation}{" "}
        <a target="_blank" rel="noopener noreferrer" href={DOCS_PACKAGES_URL}>
          {packagesLocale.empty_documentation_link}
        </a>
        .
      </p>
    </div>
  );
}

/** The list block (package/shared/list.tmpl): the filter form (when
 *  `.HasPackages`), the rows, the two empty arms, the pager. */
function PackagesListBlock(props: {
  base: string;
  items: PackageListItem[];
  page: number;
  more: boolean;
  query: string;
  typeFilter: string;
  hasPackages: boolean;
  ownerName: string;
  ownerVisibility: "public" | "limited" | "private";
  /** The R16 writer hint (`{{if and .Repository .CanWritePackages}}`); null
   *  on the owner pages (no Repository in their data). */
  repoHint: { ownerPackagesUrl: string } | null;
}) {
  return (
    <>
      {props.hasPackages ? <PackagesFilterForm query={props.query} typeFilter={props.typeFilter} /> : null}
      <div>
        {props.items.length > 0 ? (
          <div class="flex-divided-list items-with-main">
            {props.items.map((item) => (
              <PackageListItemRow item={item} ownerName={props.ownerName} ownerVisibility={props.ownerVisibility} />
            ))}
          </div>
        ) : !props.hasPackages ? (
          <PackagesEmptyPlaceholder repoHint={props.repoHint} />
        ) : (
          <p class="tw-py-4">{packagesLocale.filter_no_result}</p>
        )}
        <PackagesPagination base={props.base} page={props.page} more={props.more} keep={{ q: props.query, type: props.typeFilter }} />
      </div>
    </>
  );
}

/** The profile-grid chrome both user-arm pages share (profile.tmpl's grid:
 *  the four-wide avatar column + the twelve-wide column carrying the
 *  overview header). The avatar card renders the wave I-b C2 follow button
 *  + C3 admin gear beside the unconditional RSS anchor
 *  (profile_big_avatar.tmpl:123-136/:18/:31-33); the overview header carries
 *  the C1 Projects + Code tabs INACTIVE (header.tmpl:14-31) with the strip's
 *  one ACTIVE item the Packages tab itself: upstream marks it via
 *  `IsPackagesPage` (header.tmpl:23 — package.go:103/:197/:348/:418 set it
 *  on every handler of this family), while Repositories renders INACTIVE
 *  because `TabName` is unset here (header.tmpl:8's
 *  `eq .TabName "repositories"` — the packages routes never set TabName;
 *  profile.go:90 is the tree's only setter, fed by the `tab` form value,
 *  never "packages") — hence `repositoriesActive={false}`. */
function UserProfileGrid(props: {
  ctx: UiContext;
  user: UserProfileRow;
  chrome: UserProfileChrome;
  children: import("hono/jsx").Child;
}) {
  const username = props.user.username;
  return (
    <div class="ui container">
      <div class="ui stackable grid">
        <div class="ui four wide column">
          <ProfileAvatarCard
            user={props.user}
            followers={props.chrome.followers}
            following={props.chrome.following}
            followButton={props.chrome.followButton ?? undefined}
            viewerIsAdmin={props.chrome.viewerIsAdmin}
          />
        </div>
        <div class="ui twelve wide column tw-mb-4">
          <ProfileTabs
            username={username}
            repoCount={props.chrome.repoCount}
            starsCount={props.user.numStars}
            repositoriesActive={false}
            projectsTab={{ active: false, count: props.chrome.openProjects, href: `/${username}/-/projects` }}
            packagesTab={{ active: true, href: `/${username}/-/packages` }}
            codeTab={{ active: false, href: `/${username}/-/code` }}
          />
          {props.children}
        </div>
      </div>
    </div>
  );
}

/** The org chrome both org-arm pages share (org/header + org/menu with the
 *  Packages tab ACTIVE) — exported for pages/package-settings.tsx, the
 *  settings page's org arm. The header's follow button is the C2 arm
 *  (org/header.tmpl:17); the menu's Code tab is the C1 arm (menu.tmpl:28-32,
 *  inactive here). RECORDED DIVERGENCE (the K2 drift adjudication, module
 *  header): upstream renders the menu's Repositories item INACTIVE on this
 *  family (menu.tmpl:9's `PageIsViewRepositories` — never set here) beside
 *  the ACTIVE Packages item (:24's `IsPackagesPage`), but OrgMenu
 *  (org-home.tsx — the strip's owner, outside this wave's ownership) keys
 *  the Repositories active class on `projectsTab?.active` and carries no
 *  repositories-active control, so the upstream shape is inexpressible from
 *  this consumer; Repositories stays ACTIVE until OrgMenu's owner extends
 *  it. */
export function OrgPackagesChrome(props: {
  ctx: UiContext;
  org: OrgRecord;
  repoCount: number;
  followButton?: { following: boolean };
  children: import("hono/jsx").Child;
}) {
  return (
    <>
      <OrgHeader org={props.org} signedIn={props.ctx.viewer.kind === "user"} followButton={props.followButton} />
      <OrgMenu
        orgLink={`/${props.org.username}`}
        repoCount={props.repoCount}
        packagesTab={{ active: true, href: `/${props.org.username}/-/packages` }}
        codeTab={{ active: false, href: `/${props.org.username}/-/code` }}
      />
      {props.children}
    </>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderOwnerPackagesPage(ctx: UiContext, data: OwnerPackagesData): string {
  return renderPage(<OwnerPackagesPage ctx={ctx} data={data} />);
}

/** The R04 list page (user/overview/packages.tmpl + org arm). */
export function OwnerPackagesPage(props: { ctx: UiContext; data: OwnerPackagesData }) {
  const { ctx, data } = props;
  const ownerName = ownerNameOf(data.owner);
  const base = `/${ownerName}/-/packages`;
  const listBlock = (
    <PackagesListBlock
      base={base}
      items={data.items}
      page={data.page}
      more={data.more}
      query={data.query}
      typeFilter={data.typeFilter}
      hasPackages={data.hasPackages}
      ownerName={ownerName}
      ownerVisibility={ownerVisibilityOf(data.owner)}
      repoHint={null}
    />
  );
  if (data.owner.kind === "org") {
    return (
      <BaseLayout ctx={ctx} title={packagesLocale.title} pageClass="organization packages">
        <div class="ui container">
          <OrgPackagesChrome ctx={ctx} org={data.owner.org} repoCount={data.repoCount} followButton={data.followButton ?? undefined}>
            {listBlock}
          </OrgPackagesChrome>
        </div>
      </BaseLayout>
    );
  }
  return (
    <BaseLayout ctx={ctx} title={packagesLocale.title} pageClass="user profile packages">
      <UserProfileGrid ctx={ctx} user={data.owner.user} chrome={data}>
        {listBlock}
      </UserProfileGrid>
    </BaseLayout>
  );
}

/** The versions block (package/shared/versionlist.tmpl — the name /
 *  Versions breadcrumb, the q + sort form, the version rows). */
function PackageVersionsBlock(props: { data: OwnerPackageVersionsData }) {
  const { data } = props;
  const ownerName = ownerNameOf(data.owner);
  const base = packageWebLink(ownerName, data.pkg.type, data.pkg.lowerName);
  return (
    <>
      <p>
        <a href={base}>{data.pkg.name}</a>
        <span class="label-list">
          <PackageVisibilityBadge kind={packageVisibilityBadgeKind(data.pkg, ownerVisibilityOf(data.owner))} />
        </span>
        / <strong>{packagesLocale.versions}</strong>
      </p>
      <PackagesFilterForm query={data.query} sort={data.sort} versions />
      <div>
        {data.items.length > 0 ? (
          <div class="flex-divided-list items-with-main">
            {data.items.map((item) => (
              <div class="item">
                <div class="item-main">
                  <a
                    class="item-title"
                    href={versionWebLink(ownerName, data.pkg.type, data.pkg.lowerName, item.version.lowerVersion)}
                  >
                    {item.version.lowerVersion}
                  </a>
                  <div class="item-body">
                    {packagesLocale.published}{" "}
                    <TimeSince unixSeconds={Math.floor(item.version.createdUnix.getTime() / 1000)} tz="+0000" />
                    {item.creatorName !== null ? (
                      <>
                        {" "}
                        {packagesLocale.by} <a href={userLink(item.creatorName)}>{item.creatorName}</a>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p class="tw-py-4">{packagesLocale.filter_no_result}</p>
        )}
        <PackagesPagination base={`${base}/versions`} page={data.page} more={data.more} keep={{ q: data.query, sort: data.sort }} />
      </div>
    </>
  );
}

/** The full-document render — the versions page. */
export function renderOwnerPackageVersionsPage(ctx: UiContext, data: OwnerPackageVersionsData): string {
  return renderPage(<OwnerPackageVersionsPage ctx={ctx} data={data} />);
}

/** The versions page (user/overview/package_versions.tmpl + org arm). */
export function OwnerPackageVersionsPage(props: { ctx: UiContext; data: OwnerPackageVersionsData }) {
  const { ctx, data } = props;
  if (data.owner.kind === "org") {
    return (
      <BaseLayout ctx={ctx} title={packagesLocale.title} pageClass="organization packages">
        <div class="ui container">
          <OrgPackagesChrome ctx={ctx} org={data.owner.org} repoCount={data.repoCount} followButton={data.followButton ?? undefined}>
            <PackageVersionsBlock data={data} />
          </OrgPackagesChrome>
        </div>
      </BaseLayout>
    );
  }
  return (
    <BaseLayout ctx={ctx} title={packagesLocale.title} pageClass="user profile packages">
      <UserProfileGrid ctx={ctx} user={data.owner.user} chrome={data}>
        <PackageVersionsBlock data={data} />
      </UserProfileGrid>
    </BaseLayout>
  );
}

/** The generic install block (package/content/generic.tmpl — one curl line
 *  per file). */
function GenericInstallBlock(props: { data: PackageVersionViewData }) {
  const { data } = props;
  return (
    <div>
      <h4 class="ui top attached header">{packagesLocale.installation}</h4>
      <div class="ui attached segment">
        <div class="ui form">
          <div class="field">
            <label>
              <Icon name="octicon-terminal" /> {packagesLocale.generic_download}
            </label>
            <div class="markup">
              <pre class="code-block">
                <code>
                  {data.files.map((file) => (
                    <>
                      {genericCurlLine(
                        `https://${data.registryHost}`,
                        ownerNameOf(data.owner),
                        data.pkg.name,
                        data.version.version,
                        file.file.name,
                      )}
                      {"\n"}
                    </>
                  ))}
                </code>
              </pre>
            </div>
          </div>
          <div class="field">
            <label>
              {packagesLocale.registry_documentation}{" "}
              <a target="_blank" rel="noopener noreferrer" href={DOCS_GENERIC_URL}>
                {packagesLocale.empty_documentation_link}
              </a>
              .
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The terraform lock-status block (package/metadata/terraform.tmpl — the
 *  details-list item after the download row; the type gate rides the caller,
 *  the IsLatestVersion gate renders nothing off-latest). The lock/unlock
 *  buttons are the web.go:1117-1120 POST arms' forms (one bare POST each —
 *  no fields, the manual lock is "Manual UI Lock" server-side). GLYPH
 *  DEGRADATION: octicon-lock/octicon-unlock are not in the landed octicon
 *  allowlist — locked degrades to octicon-shield-lock, unlocked to
 *  octicon-check; the red/green text classes and the Locked-by/Unlocked
 *  texts carry the state. The Created timestamp renders TimeSince off the
 *  RFC3339 lock string (an unparsable one renders the operation alone). */
function TerraformLockStatusBlock(props: { data: PackageVersionViewData }) {
  const { data } = props;
  if (!data.isLatestVersion) return null;
  const ownerName = ownerNameOf(data.owner);
  const lock = data.terraformLock;
  const lockCreated = lock !== null && !Number.isNaN(new Date(lock.Created).getTime()) ? new Date(lock.Created) : null;
  return (
    <>
      <div class="divider"></div>
      <div class="item tw-flex tw-flex-col tw-gap-2">
        <div>
          <strong>{packagesLocale.terraform_lock_status}</strong>
        </div>
        <div>
          {lock !== null ? (
            <>
              <div class="flex-text-block">
                <Icon name="octicon-shield-lock" class="tw-text-red" />{" "}
                <span>
                  {TERRAFORM_LOCKED_BY_PREFIX}
                  {lock.Who}
                </span>
              </div>
              <div class="tw-text-xs tw-ml-6 tw-break-anywhere">
                {lockCreated !== null ? (
                  <>
                    <TimeSince unixSeconds={Math.floor(lockCreated.getTime() / 1000)} tz="+0000" />{" "}
                  </>
                ) : null}
                ({lock.Operation})
              </div>
              {data.canWritePackages ? (
                <div>
                  <form
                    action={`${versionWebLink(ownerName, data.pkg.type, data.pkg.lowerName, data.version.lowerVersion)}/terraform/unlock`}
                    method="post"
                  >
                    <button type="submit" class="ui tiny button tw-w-full">
                      {packagesLocale.terraform_unlock}
                    </button>
                  </form>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div class="flex-text-block">
                <Icon name="octicon-check" class="tw-text-green" /> <span>{packagesLocale.terraform_unlocked}</span>
              </div>
              {data.canWritePackages ? (
                <div>
                  <form
                    action={`${versionWebLink(ownerName, data.pkg.type, data.pkg.lowerName, data.version.lowerVersion)}/terraform/lock`}
                    method="post"
                  >
                    <button type="submit" class="ui tiny button tw-w-full">
                      {packagesLocale.terraform_lock}
                    </button>
                  </form>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The view block (package/shared/view.tmpl — the title header + the
 *  packages-content grid). */
function PackageVersionViewBlock(props: { data: PackageVersionViewData }) {
  const { data } = props;
  const ownerName = ownerNameOf(data.owner);
  const versionLink = versionWebLink(ownerName, data.pkg.type, data.pkg.lowerName, data.version.lowerVersion);
  return (
    <>
      <div class="issue-title-header">
        <div class="tw-flex tw-flex-wrap tw-items-center tw-gap-2">
          <h1 class="tw-mb-0">
            {data.pkg.name} ({data.version.version})
          </h1>
          <span class="label-list">
            <PackageVisibilityBadge kind={packageVisibilityBadgeKind(data.pkg, ownerVisibilityOf(data.owner))} />
          </span>
        </div>
        <div>
          {packagesLocale.published}{" "}
          <TimeSince unixSeconds={Math.floor(data.version.createdUnix.getTime() / 1000)} tz="+0000" />
          {data.creatorName !== null ? (
            <>
              {" "}
              {packagesLocale.by} <a href={userLink(data.creatorName)}>{data.creatorName}</a>
            </>
          ) : null}
          {data.repository !== null ? (
            <>
              {" "}
              {packagesLocale.in}{" "}
              <a href={data.repository.link}>
                <strong>{data.repository.fullName}</strong>
              </a>
            </>
          ) : null}
        </div>
      </div>
      <div class="packages-content">
        <div class="packages-content-left">{data.pkg.type === "generic" ? <GenericInstallBlock data={data} /> : null}</div>
        <div class="ui segment packages-content-right">
          <strong>{packagesLocale.details}</strong>
          <div class="ui relaxed list flex-items-block">
            <div class="item">
              <Icon name="octicon-package" /> {packageTypeName(data.pkg.type)}
            </div>
            {data.repository !== null ? (
              <div class="item">
                <Icon name="octicon-repo" /> <a href={data.repository.link}>{data.repository.fullName}</a>
              </div>
            ) : null}
            <div class="item">
              <Icon name="octicon-calendar" />{" "}
              <TimeSince unixSeconds={Math.floor(data.version.createdUnix.getTime() / 1000)} tz="+0000" />
            </div>
            <div class="item">
              <Icon name="octicon-download" /> {data.downloadCount}
            </div>
            {data.pkg.type === "terraform" ? <TerraformLockStatusBlock data={data} /> : null}
            <div class="item">
              <Icon name="octicon-database" /> {data.blobSizeText}
            </div>
          </div>
          <div class="divider"></div>
          <strong>
            {packagesLocale.assets} ({data.files.length})
          </strong>
          <div class="ui relaxed list">
            {data.files.map((file) => (
              <div class="item">
                <a href={`${versionLink}/files/${file.file.id}`}>{file.file.name}</a>
                <span class="tw-text-xs tw-whitespace-nowrap">{file.sizeText}</span>
              </div>
            ))}
          </div>
          <div class="divider"></div>
          <strong>
            {packagesLocale.versions} ({data.totalVersionCount})
          </strong>
          <a class="tw-float-right" href={`${packageWebLink(ownerName, data.pkg.type, data.pkg.lowerName)}/versions`}>
            {packagesLocale.versions_view_all}
          </a>
          <div class="ui relaxed list">
            {data.latestVersions.map((latest) => (
              <div class="item tw-flex">
                <a
                  class="tw-flex-1 gt-ellipsis"
                  title={latest.version}
                  href={versionWebLink(ownerName, data.pkg.type, data.pkg.lowerName, latest.lowerVersion)}
                >
                  {latest.version}
                </a>
                <span class="tw-text-xs">{absoluteShort(latest.createdUnix)}</span>
              </div>
            ))}
          </div>
          {data.canWritePackages || data.repository !== null ? (
            <>
              <div class="divider"></div>
              <div class="ui relaxed list flex-items-block">
                {data.repository !== null ? (
                  <div class="item">
                    <Icon name="octicon-issue-opened" />{" "}
                    <a href={`${data.repository.link}/issues`}>{packagesLocale.issues}</a>
                  </div>
                ) : null}
                {data.canWritePackages ? (
                  <>
                    <div class="item">
                      <Icon name="octicon-tools" />{" "}
                      <a href={packageSettingsLink(ownerName, data.pkg.type, data.pkg.lowerName)}>
                        {packagesLocale.settings}
                      </a>
                    </div>
                    <div class="item">
                      <Icon name="octicon-trash" />{" "}
                      <details class="ui basic red button tw-p-0">
                        <summary class="tw-p-2">{packagesLocale.delete_version}</summary>
                        <div class="ui attached segment tw-text-left">
                          <form class="ui form" action={versionLink} method="post">
                            <div class="ui warning message tw-break-anywhere">
                              {packagesLocale.delete_notice_pre}
                              {data.pkg.name} ({data.version.version})
                              {packagesLocale.delete_notice_tail}
                            </div>
                            <button type="submit" class="ui red ok button">
                              <Icon name="octicon-check" /> {packagesLocale.modal_yes}
                            </button>
                          </form>
                        </div>
                      </details>
                    </div>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** The full-document render — the version view. */
export function renderOwnerPackageVersionViewPage(ctx: UiContext, data: PackageVersionViewData): string {
  return renderPage(<OwnerPackageVersionViewPage ctx={ctx} data={data} />);
}

/** The version view page (templates/package/view.tmpl + org arm). */
export function OwnerPackageVersionViewPage(props: { ctx: UiContext; data: PackageVersionViewData }) {
  const { ctx, data } = props;
  if (data.owner.kind === "org") {
    return (
      <BaseLayout ctx={ctx} title={data.pkg.name} pageClass="organization packages">
        <div class="ui container">
          <OrgPackagesChrome ctx={ctx} org={data.owner.org} repoCount={data.repoCount} followButton={data.followButton ?? undefined}>
            <PackageVersionViewBlock data={data} />
          </OrgPackagesChrome>
        </div>
      </BaseLayout>
    );
  }
  return (
    <BaseLayout ctx={ctx} title={data.pkg.name} pageClass="user profile packages">
      <UserProfileGrid ctx={ctx} user={data.owner.user} chrome={data}>
        <PackageVersionViewBlock data={data} />
      </UserProfileGrid>
    </BaseLayout>
  );
}

/** The full-document render — the R16 repo tab. */
export function renderRepoPackagesPage(ctx: UiContext, data: RepoPackagesData): string {
  return renderPage(<RepoPackagesPage ctx={ctx} data={data} />);
}

/** The R16 repo tab (templates/repo/packages.tmpl — repo/header + the shared
 *  list; the tab strip's Packages item is ACTIVE). `ctx.repo` carries the
 *  header (BaseLayout renders it whenever resolved — the R16 handler always
 *  resolves the repo first). */
export function RepoPackagesPage(props: { ctx: UiContext; data: RepoPackagesData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) {
    throw new Error("RepoPackagesPage requires ctx.repo (the R16 handler resolves it first)");
  }
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={packagesLocale.title} pageClass="repository packages" activeTab="packages">
      <div class="ui container">
        <PackagesListBlock
          base={`${repoLink}/packages`}
          items={data.items}
          page={data.page}
          more={data.more}
          query={data.query}
          typeFilter={data.typeFilter}
          hasPackages={data.hasPackages}
          ownerName={data.ownerName}
          ownerVisibility={data.ownerVisibility}
          repoHint={
            data.canWritePackages
              ? { ownerPackagesUrl: `/${repo.ownerNamespace}/-/packages` }
              : null
          }
        />
      </div>
    </BaseLayout>
  );
}
