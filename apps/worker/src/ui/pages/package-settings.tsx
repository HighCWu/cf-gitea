/**
 * The PACKAGES UI write arms — census gap #5's settings page + the delete /
 * terraform-lock seams (SPEC-0016 M2's downstream wave over the landed read
 * family, pages/packages.tsx). Upstream at the pin fc4936884584:
 *
 *   - `web.go:1121-1127` — the settings pair inside the `/{username}/-`
 *     packages group: `m.Group("/settings/{type}/{name}", { m.Get("",
 *     user.PackageSettings); m.Post("", web.Bind[*forms.PackageSettingForm](),
 *     user.PackageSettingsPost) }, reqPackageAccess(perm.AccessModeWrite))`
 *     — BOTH arms behind the WRITE mode (the `< mode` arm answers 404,
 *     web.go:937-941's closure).
 *   - `web.go:1115` — `POST /{type}/{name}/{version}` →
 *     user.PackageVersionDelete (package.go:503-528), also write-gated.
 *   - `web.go:1117-1120` — VERIFIED AT THE PIN: `m.Group("/terraform",
 *     { m.Post("/lock", user.ActionPackageTerraformLock);
 *     m.Post("/unlock", user.ActionPackageTerraformUnlock) },
 *     reqPackageAccess(perm.AccessModeWrite))` under `/{version}` — the
 *     package VIEW's manual lock/unlock buttons for terraform-state
 *     packages (templates/package/metadata/terraform.tmpl renders the
 *     forms; templates/package/content/terraform.tmpl's install block is
 *     the read-side twin). Not a settings surface — the mission's
 *     ":1117-1120 in the packages UI" resolves to these two POSTs, ported
 *     here as the seams + in pages/packages.tsx as the forms.
 *   - PIN CORRECTION to the mission text: the settings page at this pin
 *     carries NO visibility radios — `templates/package/settings.tmpl`'s
 *     visibility section is the INHERIT note ("Package visibility is
 *     inherited from the owner …") plus a link to the OWNER's settings
 *     (`{{.ContextUser.SettingsLink}}`); the POST switch is
 *     `action=link` (the repository link) | `action=delete` (the whole
 *     package) ONLY (PackageSettingsPost, package.go:435-442). What the
 *     pin registers is what ported here.
 *
 * ## Handlers (package.go:409-593) and their ports
 *
 *   - GET PackageSettings (:409-432): the descriptor through the route
 *     identity, Title = the package name, CanWritePackages, LinkedRepoName
 *     (GetRepositoryByID when Package.RepoID > 0). Port: the loader reads
 *     the same over the landed services.
 *   - POST PackageSettingsPost (:435-442) → action switch:
 *     - `link` (:444-474): empty repo_name → SetRepositoryLink(id, 0) →
 *       flash unlink.success + JSONRedirect(""); a named repo →
 *       GetRepositoryByName(owner, name) → miss = JSONError(link.
 *       repo_not_found); hit = SetRepositoryLink → flash link.success +
 *       JSONRedirect(""). PORT (the no-session-flash convention + the
 *       admin-monitor banner pattern): the success arms answer a bare 303
 *       onto the settings page (JSONRedirect("") reloads it); the
 *       repo-missing arm re-renders the GET page at 200 with the
 *       `Repository %s not found.` banner.
 *     - `delete` (:476-501): the typed package_name must EQUAL the package
 *       name (mismatch → flash delete.invalid_package_name + redirect back
 *       to the settings page), then RemovePackage (:681 runs the
 *       specialization's OnBeforeRemovePackageAll — terraform's is the
 *       LOCKED refusal, spec.go:50-62 "packages.terraform.delete.locked")
 *       → flash delete.success + redirect `/{owner}/-/packages`. PORT: the
 *       mismatch and locked arms re-render the GET page at 200 with the
 *       exact upstream banner text; success answers the bare 303 onto the
 *       owner's packages list.
 *   - PackageVersionDelete (:503-528): RemovePackageVersion (:520 runs
 *     OnBeforeRemovePackageVersion — terraform's LOCKED then LATEST
 *     refusals, spec.go:64-80: "packages.terraform.delete.locked" /
 *     "…delete.latest"); the redirect target is the package page while ANY
 *     non-internal version remains, else the owner's packages list
 *     (ExistVersion :517-520). PORT: the guard order and the target split
 *     ride verbatim; the flash texts are the no-session-flash reduction
 *     (the guard arms answer the SAME 303 — no partial state: the guards
 *     precede the landed deletePackageVersionAndReferences).
 *   - ActionPackageTerraformLock (:555-589): the type gate (non-terraform →
 *     NotFound), GetLock → already locked = flash error +
 *     redirect(VersionWebLink), else SetLock{uuid, "Manual UI Lock", doer
 *     name, now} + flash success + redirect(VersionWebLink).
 *   - ActionPackageTerraformUnlock (:591-604): the type gate, RemoveLock,
 *     flash + redirect(VersionWebLink). PORT of both: the type gate lives
 *     at the handler (the route shape arbitrates type=terraform only);
 *     the seams run the landed terraform service (getTerraformLock /
 *     setTerraformLock / removeTerraformLock); the answers are the bare
 *     303 onto the version page (both arms — the already-locked refusal
 *     keeps the guard so a double-POST can never double-set).
 *
 * ## DOM (templates/package/settings.tmpl)
 *
 * `page-content package settings options` (+` organization` on the org
 * arm): org/header ALONE on the org arm (no org menu — upstream renders
 * none here), the org_profile_avatar strip + the overview tabs on the user
 * arm, then the container: base/alert (the flash banner slot), the
 * breadcrumb (`{package anchor} {badge} / Settings`), and the three
 * sections — visibility (inherit note + the owner-settings link button),
 * link (the description + three notices + the `action=link` form with the
 * repo_name input), danger zone (the delete row; upstream's show-modal
 * button + `#delete-package-modal` dialog reduce to the landed
 * org-settings danger-zone `<details>` form — the typed `package_name`
 * confirmation field kept VERBATIM: label, the red package name, required
 * input maxlength 100; the dialog's No button drops, the Yes submit and
 * the warning notice stay).
 *
 * The user arm's visibility button targets `/{owner}/settings` — upstream's
 * `ContextUser.SettingsLink` spells orgs `/org/{name}/settings`
 * (models/user/user.go:334-339), a URL family this codebase does not host;
 * the landed org settings page is `/{org}/settings` (the dead-link rule's
 * bend, documented here). Users target `/user/settings` (the same fixed
 * literal upstream spells).
 *
 * ## Mount (the b91dd1c pattern — ui/index.ts is a sibling's file)
 *
 * Reported in the unit's handoff: the parseUiRoute claims (settings GET
 * +POST + the two terraform POSTs + the version-delete POST) sit in the
 * `/{username}/-/packages` matcher after the file-download arm; the
 * handlers ride `resolveOwnerPackagesRequest` + a write-mode gate
 * (`ownerPackagesAccessMode` … `accessModeAtLeast(mode, "write")` → the
 * 404 shell) + `sameOriginGuard` on every POST. See the report.
 *
 * Tests drive the module arms directly (renderToString over the page, the
 * loaders and the five write seams against real D1/R2 bindings) — the
 * mounted route arms belong to the integrator's landing window.
 */

import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, packages as packagesTable, repositories } from "../../db/schema";
import {
  accessModeAtLeast,
  deletePackageAndReferences,
  deletePackageVersionAndReferences,
  linkPackageToRepo,
  unlinkPackageFromRepo,
  type PackageRow,
  type PackageVersionRow,
} from "../../services/packages/model";
import {
  getTerraformLock,
  isTerraformLockLocked,
  removeTerraformLock,
  setTerraformLock,
  type TerraformLockInfo,
} from "../../services/packages/terraform";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { OrgHeader } from "./org-home";
import {
  ownerPackagesAccessMode,
  ownerPackagesChrome,
  ownerNameOf,
  ownerVisibilityOf,
  packageSettingsLink,
  packageVisibilityBadgeKind,
  packageWebLink,
  PackageVisibilityBadge,
  type PackagesOwner,
} from "./packages";
import { ProfileTabs, userDisplayName } from "./user-profile";

// ---------------------------------------------------------------------------
// The locale (gitea/options/locale/locale_en-US.json at the pin)
// ---------------------------------------------------------------------------

/** The settings page's chrome text (upstream keys cited; the three link
 *  notices render as the template's bullet lines). */
export const packagesSettingsLocale = {
  settings: "Settings", // "repo.settings"
  danger_zone: "Danger Zone", // "repo.settings.danger_zone"
  visibility: "Package visibility", // "packages.settings.visibility"
  visibility_inherit:
    "Package visibility is inherited from the owner and cannot be changed independently here. To change it, update the visibility settings of the user or organization that owns this package.", // "packages.settings.visibility.inherit"
  visibility_button: "Change owner visibility", // "packages.settings.visibility.button"
  link: "Link this package to a repository", // "packages.settings.link"
  link_description:
    "If you link a package with a repository, the package will appear in the repository's package list.", // "packages.settings.link.description"
  link_notice1: "Only repositories under the same owner can be linked.", // "packages.settings.link.notice1"
  link_notice2: "Linking a repository does not change the package visibility.", // "…notice2"
  link_notice3: "Leaving the field empty will remove the link.", // "…notice3"
  link_button: "Update Repository Link", // "packages.settings.link.button"
  link_repo_placeholder: "Search repos…", // "search.repo_kind"
  delete: "Delete package", // "packages.settings.delete"
  delete_description: "Deleting a package is permanent and cannot be undone.", // "packages.settings.delete.description"
  delete_notice_package_pre: "You are about to delete ", // "packages.settings.delete.notice.package" (pre-name)
  delete_notice_package_tail: " and all its versions. This operation is irreversible, are you sure?", // (post-name)
  delete_confirm: "Enter package name to confirm", // "packages.settings.delete.confirm"
  delete_invalid_package_name: "The package name you entered is incorrect.", // "…delete.invalid_package_name"
  terraform_delete_locked: "Terraform state is locked and cannot be deleted.", // "packages.terraform.delete.locked"
  package_name: "Package Name", // "packages.name"
  modal_yes: "Yes", // "modal.yes"
  repo_not_found_prefix: "Repository ", // "packages.settings.link.repo_not_found" (pre-name)
  repo_not_found_tail: " not found.", // (post-name)
} as const;

// ---------------------------------------------------------------------------
// The GET loader (PackageSettings, package.go:409-432)
// ---------------------------------------------------------------------------

/** The settings page's render inputs: the admitted owner + the package row
 *  (the route identity resolved by the handler), the linked-repo display
 *  name, the write rank (handler-gated BEFORE this runs — the render is
 *  the write gate's postcondition), and the chrome counts. */
export interface PackageSettingsData {
  owner: PackagesOwner;
  pkg: PackageRow;
  /** `LinkedRepoName` (package.go:425-430) — the linked repo's slug; null
   *  when the package carries no repository link. */
  linkedRepoName: string | null;
  /** `CanWritePackages` — the route gate already 404-shells below write;
   *  the field documents the arm the render ran behind. */
  canWritePackages: boolean;
  repoCount: number;
  followers: number;
  following: number;
  /** The USER arm's Projects-tab count (header.tmpl:17-20 — the OPEN
   *  projects total, loadHeaderCount parity). */
  openProjects: number;
  /** The ORG arm's header follow button (org/header.tmpl:17 — the same
   *  template renders on every page of the family). The user arm renders
   *  org_profile_avatar (no follow control upstream), so its value stays
   *  unread there. */
  followButton: { following: boolean } | null;
}

/**
 * PackageSettings' data (:409-432): the linked repo row (GetRepositoryByID
 * when RepoID > 0), the write rank over the SAME ownerPackagesAccessMode
 * ladder the route gate ran, and the chrome counts (the user arm's tabs +
 * avatar strip). A vanished linked-repo row (repo deleted with the link
 * left behind is impossible — §5.6's repo-delete unlinks — but a foreign
 * row guards the render) simply renders the empty input.
 */
export async function loadPackageSettingsData(
  d1: D1Database,
  owner: PackagesOwner,
  viewer: Viewer,
  origin: string,
  pkg: PackageRow,
): Promise<PackageSettingsData> {
  const ownerId = owner.kind === "org" ? owner.org.id : owner.user.id;
  const doer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };

  // The CURRENT package row (upstream reads ctx.Package.Descriptor.Package
  // — the assignment's fresh read; the route identity's row can predate a
  // link write the same request's siblings made).
  const current = (await drizzle(d1).select().from(packagesTable).where(eq(packagesTable.id, pkg.id)).get()) ?? pkg;

  let linkedRepoName: string | null = null;
  if (current.repoId !== null) {
    const repoRow = await drizzle(d1)
      .select({ slug: repositories.slug })
      .from(repositories)
      .where(eq(repositories.id, current.repoId))
      .get();
    if (repoRow !== undefined) linkedRepoName = repoRow.slug;
  }

  const chrome = await ownerPackagesChrome(d1, owner, doer);
  const mode = await ownerPackagesAccessMode(
    d1,
    { id: ownerId, type: owner.kind === "org" ? "org" : "user", visibility: ownerVisibilityOf(owner) },
    doer,
  );
  return {
    owner,
    pkg: current,
    linkedRepoName,
    canWritePackages: accessModeAtLeast(mode, "write"),
    repoCount: chrome.repoCount,
    followers: chrome.followers,
    following: chrome.following,
    openProjects: chrome.openProjects,
    followButton: chrome.followButton,
  };
}

// ---------------------------------------------------------------------------
// The POST seams (PackageSettingsPost + PackageVersionDelete + the
// terraform lock arms) — one outcome union each, the handler answers
// ---------------------------------------------------------------------------

/** The settings form's parsed shape (forms.PackageSettingForm :301-305 +
 *  the delete confirm's package_name FormString :480). */
export interface ParsedPackageSettingsForm {
  action: string;
  repoName: string;
  packageName: string;
}

export function parsePackageSettingsForm(form: URLSearchParams): ParsedPackageSettingsForm {
  return {
    action: form.get("action") ?? "",
    repoName: (form.get("repo_name") ?? "").trim(),
    packageName: form.get("package_name") ?? "",
  };
}

/** `GetRepositoryByName` (repo_model) by OWNER ID + the lower-cased slug —
 *  the link action's lookup arm. */
function findRepoIdByOwnerAndName(d1: D1Database, ownerId: number, name: string): Promise<string | null> {
  return drizzle(d1)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerId, ownerId), eq(repositories.slug, name.toLowerCase())))
    .get()
    .then((row) => row?.id ?? null);
}

/** The `link` action's body (packageSettingsPostActionLink :444-474) over
 *  the landed link/unlink pair (model.ts — SetRepositoryLink's two arms):
 *  an empty name unlinks; a named repo must live under the SAME owner.
 *  The upstream JSONError/JSONRedirect pairs fold into the outcome union
 *  (the module header's flash reduction). */
export async function applyPackageSettingsLink(
  d1: D1Database,
  ownerId: number,
  pkg: PackageRow,
  repoName: string,
): Promise<{ kind: "ok" } | { kind: "repo-missing"; repoName: string }> {
  if (repoName === "") {
    await unlinkPackageFromRepo(d1, pkg.id);
    return { kind: "ok" };
  }
  const repoId = await findRepoIdByOwnerAndName(d1, ownerId, repoName);
  if (repoId === null) return { kind: "repo-missing", repoName };
  await linkPackageToRepo(d1, pkg.id, repoId);
  return { kind: "ok" };
}

/** The terraform specialization's OnBeforeRemovePackageAll port
 *  (services/packages/terraform/spec.go:50-62): a LOCKED terraform state
 *  refuses every delete. Other types run no guard (the spec registry's
 *  no-op default). */
async function terraformDeleteGuardAll(d1: D1Database, pkg: PackageRow): Promise<"locked" | null> {
  if (pkg.type !== "terraform") return null;
  const lock = await getTerraformLock(d1, pkg.id);
  return isTerraformLockLocked(lock) ? "locked" : null;
}

/** The terraform specialization's OnBeforeRemovePackageVersion port
 *  (spec.go:64-80): LOCKED first, then LATEST — the max-id version of the
 *  package (SearchLatestVersions' GROUP-BY arm reduces to this on a fixed
 *  package). */
async function terraformDeleteGuardVersion(
  d1: D1Database,
  pkg: PackageRow,
  version: PackageVersionRow,
): Promise<"locked" | "latest" | null> {
  if (pkg.type !== "terraform") return null;
  const lock = await getTerraformLock(d1, pkg.id);
  if (isTerraformLockLocked(lock)) return "locked";
  const latest = await drizzle(d1)
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.isInternal, false)))
    .orderBy(desc(packageVersions.id))
    .limit(1)
    .all();
  return latest[0]?.id === version.id ? "latest" : null;
}

/** The `delete` action's body (packageSettingsPostActionDelete :476-501 +
 *  RemovePackage's :681 specialization hook): the typed-name equality
 *  first (upstream compares BEFORE removing), then the locked guard, then
 *  the landed delete cascade. No partial state: every refusal precedes
 *  the first write. */
export async function applyPackageSettingsDelete(
  d1: D1Database,
  pkg: PackageRow,
  packageName: string,
): Promise<"mismatch" | "locked" | "ok"> {
  if (packageName !== pkg.name) return "mismatch";
  const locked = await terraformDeleteGuardAll(d1, pkg);
  if (locked !== null) return locked;
  await deletePackageAndReferences(d1, pkg.id);
  return "ok";
}

/** PackageVersionDelete's body (:503-528) with the OnBeforeRemovePackageVersion
 *  hook (:520): the guard union, then the landed version delete. The
 *  caller answers the redirect split below (upstream answers the SAME
 *  target on the flash-error arms — no partial state here either). */
export async function deletePackageVersionGuarded(
  d1: D1Database,
  pkg: PackageRow,
  version: PackageVersionRow,
): Promise<"locked" | "latest" | "ok"> {
  const guard = await terraformDeleteGuardVersion(d1, pkg, version);
  if (guard !== null) return guard;
  await deletePackageVersionAndReferences(d1, version.id);
  return "ok";
}

/** The version-delete redirect split (:517-522): the package page while
 *  any non-internal version remains (ExistVersion), else the owner's
 *  packages list — `HomeLink() + "/-/packages"`. The owner's CURRENT
 *  display name rides the callers' resolved owner. */
export async function resolveVersionDeleteRedirect(
  d1: D1Database,
  ownerName: string,
  pkg: PackageRow,
): Promise<string> {
  const remaining = await drizzle(d1)
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.isInternal, false)))
    .limit(1)
    .all();
  if (remaining.length > 0) return packageWebLink(ownerName, pkg.type, pkg.lowerName);
  return `/${ownerName}/-/packages`;
}

/** ActionPackageTerraformLock's body (:555-589) over the landed lock
 *  service: already-locked refuses (the double-POST guard), else the
 *  manual lock lands — uuid (crypto.randomUUID, the AGENTS rule),
 *  "Manual UI Lock", the doer's name, the RFC3339 now. */
export async function lockPackageTerraformState(
  d1: D1Database,
  pkg: PackageRow,
  who: string,
  now: Date = new Date(),
): Promise<"already-locked" | "ok"> {
  const existing = await getTerraformLock(d1, pkg.id);
  if (isTerraformLockLocked(existing)) return "already-locked";
  const lock: TerraformLockInfo = {
    ID: crypto.randomUUID(),
    Operation: "Manual UI Lock",
    Info: "",
    Who: who,
    Version: "",
    Created: now.toISOString(),
    Path: "",
  };
  await setTerraformLock(d1, pkg.id, lock);
  return "ok";
}

/** ActionPackageTerraformUnlock's body (:591-604): RemoveLock — the
 *  property delete is idempotent upstream (DeletePropertiesIfExist), so
 *  the seam carries no not-locked arm. */
export async function unlockPackageTerraformState(d1: D1Database, pkg: PackageRow): Promise<"ok"> {
  await removeTerraformLock(d1, pkg.id);
  return "ok";
}

// ---------------------------------------------------------------------------
// The page (templates/package/settings.tmpl)
// ---------------------------------------------------------------------------

/** The flash banner the POST re-renders carry (the admin-monitor pattern —
 *  the no-session-flash reduction's substitute). */
export interface PackageSettingsFlash {
  kind: "positive" | "negative";
  text: string;
}

/** The visibility section's owner-settings link (SettingsLink :334-339):
 *  the user arm targets the fixed `/user/settings`; the org arm targets
 *  the LANDED org settings page (the module header's URL bend). */
function ownerSettingsLink(owner: PackagesOwner): string {
  return owner.kind === "org" ? `/${owner.org.username}/settings` : "/user/settings";
}

/** The user arm's avatar strip (shared/user/org_profile_avatar.tmpl — the
 *  avatar + display-name link + the limited/private label). */
function SettingsAvatarStrip(props: { owner: PackagesOwner }) {
  const name = ownerNameOf(props.owner);
  const visibility =
    props.owner.kind === "user"
      ? props.owner.user.visibility
      : props.owner.kind === "org"
        ? props.owner.org.visibility
        : "public";
  const displayName =
    props.owner.kind === "user"
      ? userDisplayName(props.owner.user)
      : props.owner.kind === "org" && props.owner.org.fullName !== null && props.owner.org.fullName !== ""
        ? props.owner.org.fullName
        : name;
  return (
    <div class="ui container">
      <div class="ui vertically grid head">
        <div class="column">
          <div class="ui header flex-text-block tw-break-anywhere">
            <span class="ui avatar" aria-hidden="true">
              <Icon name={props.owner.kind === "org" ? "octicon-organization" : "octicon-person"} size={100} />
            </span>
            <span class="tw-text-text-light">
              <a class="muted" href={`/${name}`}>
                {displayName}
              </a>
            </span>
            <span class="org-visibility">
              {visibility === "limited" ? <div class="ui medium basic horizontal label">Limited</div> : null}
              {visibility === "private" ? <div class="ui medium basic horizontal label">Private</div> : null}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The settings page (templates/package/settings.tmpl — `page-content
 *  package settings options` +` organization`). The flash banner renders
 *  in the base/alert slot (null on the plain GET). The org arm renders
 *  org/header ALONE (upstream registers no org menu on this page); the
 *  user arm renders the avatar strip + the overview tabs (the
 *  user/overview/header twin) — both inside the template's container
 *  order. */
export function PackageSettingsPage(props: {
  ctx: UiContext;
  data: PackageSettingsData;
  flash?: PackageSettingsFlash | null;
}) {
  const { ctx, data } = props;
  const ownerName = ownerNameOf(data.owner);
  // descriptor.go:84-87 — `/settings/{type}/{name}` over the LOWER name
  // (the same shape packageSettingsLink builds for the view's anchor).
  const settingsLink = packageSettingsLink(ownerName, data.pkg.type, data.pkg.lowerName);
  const badgeKind = packageVisibilityBadgeKind(data.pkg, ownerVisibilityOf(data.owner));
  const flash = props.flash !== undefined && props.flash !== null ? props.flash : null;
  const body = (
    <>
      {flash !== null ? (
        <div
          class={`ui ${flash.kind} message flash-message flash-${flash.kind === "positive" ? "success" : "error"}`}
        >
          <div class="tw-text-center">{flash.text}</div>
        </div>
      ) : null}
      <p>
        <a href={packageWebLink(ownerName, data.pkg.type, data.pkg.lowerName)}>{data.pkg.name}</a>
        <span class="label-list">
          <PackageVisibilityBadge kind={badgeKind} />
        </span>
        / <strong>{packagesSettingsLocale.settings}</strong>
      </p>
      <h4 class="ui top attached header">{packagesSettingsLocale.visibility}</h4>
      <div class="ui attached segment">
        <p>{packagesSettingsLocale.visibility_inherit}</p>
        <a class="ui basic button" href={ownerSettingsLink(data.owner)}>
          {packagesSettingsLocale.visibility_button}
        </a>
      </div>
      <h4 class="ui top attached header">{packagesSettingsLocale.link}</h4>
      <div class="ui attached segment">
        <p>{packagesSettingsLocale.link_description}</p>
        <p>- {packagesSettingsLocale.link_notice1}</p>
        <p>- {packagesSettingsLocale.link_notice2}</p>
        <p>- {packagesSettingsLocale.link_notice3}</p>
        {/* settings.tmpl's link form — the form-fetch-action/ignore-dirty
            JS attributes drop (the bundle's progressive enhancement); the
            fields are the template's verbatim pair. */}
        <form class="ui form flex-text-block" action={settingsLink} method="post">
          <input type="hidden" name="action" value="link" />
          <input
            name="repo_name"
            value={data.linkedRepoName ?? ""}
            placeholder={packagesSettingsLocale.link_repo_placeholder}
            autocomplete="off"
          />
          <button type="submit" class="ui primary button">
            {packagesSettingsLocale.link_button}
          </button>
        </form>
      </div>
      <h4 class="ui top attached error header">{packagesSettingsLocale.danger_zone}</h4>
      <div class="ui attached error danger segment">
        <div class="flex-divided-list items-with-main">
          <div class="item tw-items-center">
            <div class="item-main">
              <div class="item-title">{packagesSettingsLocale.delete}</div>
              <div class="item-body">{packagesSettingsLocale.delete_description}</div>
            </div>
            <div class="item-trailing">
              {/* The show-modal button + dialog reduce to the landed
                  org-settings danger-zone details form; the typed
                  package_name confirmation stays verbatim (the dialog's No
                  button drops — the details form IS the confirmation). */}
              <details class="ui basic red button tw-p-0">
                <summary class="tw-p-2">{packagesSettingsLocale.delete}</summary>
                <div class="ui attached segment tw-text-left">
                  <form class="ui form" action={settingsLink} method="post">
                    <input type="hidden" name="action" value="delete" />
                    <div class="ui warning message tw-break-anywhere">
                      {packagesSettingsLocale.delete_notice_package_pre}
                      {data.pkg.name}
                      {packagesSettingsLocale.delete_notice_package_tail}
                    </div>
                    <div class="field">
                      <label>
                        {packagesSettingsLocale.delete_confirm} <span class="tw-text-red">{data.pkg.name}</span>
                      </label>
                    </div>
                    <div class="required field">
                      <label>{packagesSettingsLocale.package_name}</label>
                      <input name="package_name" required maxlength={100} />
                    </div>
                    <button type="submit" class="ui red ok button">
                      <Icon name="octicon-check" /> {packagesSettingsLocale.modal_yes}
                    </button>
                  </form>
                </div>
              </details>
            </div>
          </div>
        </div>
      </div>
    </>
  );
  if (data.owner.kind === "org") {
    return (
      <BaseLayout ctx={ctx} title={data.pkg.name} pageClass="package settings options organization">
        {/* org/header.tmpl renders on EVERY page of the org packages family
            — the follow button (header.tmpl:17's follow_unfollow include)
            rides the loader's IsFollowing state. */}
        <OrgHeader org={data.owner.org} signedIn={ctx.viewer.kind === "user"} followButton={data.followButton ?? undefined} />
        <div class="ui container">{body}</div>
      </BaseLayout>
    );
  }
  const user = data.owner.user;
  return (
    <BaseLayout ctx={ctx} title={data.pkg.name} pageClass="package settings options">
      <SettingsAvatarStrip owner={data.owner} />
      <div class="ui container">
        {/* The overview header (user/overview/header.tmpl): the Packages tab
            ACTIVE (`.IsPackagesPage` — PackageSettings' package.go:418), the
            wave I-b C1 Projects + Code tabs INACTIVE (header.tmpl:14-31), and
            Repositories INACTIVE too — TabName is unset on this page
            (header.tmpl:8's `eq .TabName "repositories"`; the tree's only
            TabName setter is profile.go:90, never reached here). */}
        <ProfileTabs
          username={user.username}
          repoCount={data.repoCount}
          starsCount={user.numStars}
          repositoriesActive={false}
          projectsTab={{ active: false, count: data.openProjects, href: `/${user.username}/-/projects` }}
          packagesTab={{ active: true, href: `/${user.username}/-/packages` }}
          codeTab={{ active: false, href: `/${user.username}/-/code` }}
        />
        {body}
      </div>
    </BaseLayout>
  );
}

/** The full-document render — the settings page (the render.tsx pattern:
 *  the JSX invocation lives beside the component). */
export function renderPackageSettingsPage(
  ctx: UiContext,
  data: PackageSettingsData,
  flash: PackageSettingsFlash | null = null,
): string {
  return renderPage(<PackageSettingsPage ctx={ctx} data={data} flash={flash} />);
}
