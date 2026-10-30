/**
 * The branch selector — the upstream VUE ISLAND (webui-parity top-drift 1
 * retired): templates/repo/branch_dropdown.tmpl at the pin renders a
 * container armed with `data-global-init="initRepoBranchTagSelector"` and
 * the ~20 `data-text-*` / `data-current-*` / `data-ref-link-template`
 * attributes the official bundle's RepoBranchTagSelector.vue reads
 * (web_src/js/features/repo-legacy.ts registers the island; it mounts and
 * REPLACES this container's contents), holding only the pre-mount dummy
 * `.ui.dropdown.custom.branch-selector-dropdown` — the `custom` class keeps
 * Fomantic's generic `.ui.dropdown` enhancement off (common-page.ts's
 * `:not(.custom)` selector), so the menu is the island's client-DOM render
 * exclusively: the Branches/Tags tab strip, the filter box, the
 * default-branch label, the view-all-branches/tags entries and the RSS
 * marks never render server-side.
 *
 * The island fetches the ref lists client-side from the LANDED aux JSON
 * feeds — `{repoLink}/branches/list` (pages/branches-list-aux.ts) and
 * `{repoLink}/tags/list` (pages/tag-list-aux.ts), the `{results: string[]}`
 * envelope upstream's branchTagSearchResponse marshals — so the old
 * server-rendered menu items are gone; the accepted-but-unused `refs` prop
 * keeps every call site's types intact (home/commits/file-view/blame pass
 * their `data.refs` unchanged).
 *
 * ## Call-site → upstream arm mapping
 *
 * Both landed consumers are upstream's own arms of the shared template:
 * the `/src` family is view_content.tmpl:11-21 (tab strip on, ref-link
 * template `{RepoLink}/src/{RefType}/{RefShortName}/{TreePath}`,
 * view-all-branches/tags entries on); the `/commits` family is
 * commits.tmpl:9-18 (same tab strip, the `/commits/` link template, NO
 * view-all entry).
 *
 * ## Documented reductions (the attrs upstream arms that we cannot)
 *
 * - `data-allow-create-new-ref="false"`: upstream arms `.CanCreateBranch`
 *   (a writer signal the call sites do not thread — the component carries
 *   no viewer), so the island's create-ref-under-search entry stays off;
 *   the POST route it would target (`/branches/_new/...`) is landed
 *   (pages/branches.tsx's inline forms), so arming it is a call-site wave.
 * - `data-current-repo-default-branch=""`: the default-branch name is not a
 *   selector input upstream either (it reads `.Repository.DefaultBranch`);
 *   the empty value simply disables the menu's "default" label (the Vue
 *   compares `refShortName === currentRepoDefaultBranch`).
 * - `data-enable-feed="false"`: upstream defaults EnableFeed=true
 *   (modules/setting/other.go:21) and the island then renders per-branch
 *   RSS marks onto `{repoLink}/rss/branch/{name}` — a route this repo does
 *   not serve (the landed feed XML covers releases/tags/user), so armed
 *   marks would be dead links (the §2.4.1 rule); upstream's RSS-absent
 *   posture is already the documented repo-header divergence.
 */

import type { RefType } from "../index";
import { Icon } from "../shell";

/** The ref universe one selector's page resolved (listRefs output) —
 *  accepted for call-site compatibility only; the island fetches its lists
 *  client-side (module header). */
export interface SelectorRefs {
  branches: readonly string[];
  tags: readonly string[];
}

export function BranchSelector(props: {
  repoLink: string;
  /** The family the items navigate within — maps to the upstream call
   *  site's `RefLinkTemplate` + `ShowViewAllRefsEntry` pair (module
   *  header): `/src` (view_content.tmpl) or `/commits` (commits.tmpl). */
  family: "src" | "commits";
  refs: SelectorRefs;
  /** The active ref's URL type + name — the dummy button's icon/label and
   *  the island's `data-current-ref-*` pair (highlighted item). */
  active?: { refType: RefType; ref: string };
  /** Tree path preserved across ref switches (file view) — the island
   *  substitutes it into the link template's `{TreePath}` slot. */
  treePath?: string;
}) {
  const refLinkTemplate =
    props.family === "src"
      ? "{RepoLink}/src/{RefType}/{RefShortName}/{TreePath}" // view_content.tmpl:18
      : "{RepoLink}/commits/{RefType}/{RefShortName}/{TreePath}"; // commits.tmpl:16
  const showViewAllRefsEntry = props.family === "src"; // view_content.tmpl:20; commits.tmpl passes none
  const refType = props.active?.refType;
  const buttonIcon = refType === "tag" ? "octicon-tag" : refType === "branch" ? "octicon-git-branch" : "octicon-git-commit";
  return (
    <div
      class=""
      data-global-init="initRepoBranchTagSelector"
      data-text-branches="Branches"
      data-text-tags="Tags"
      data-text-filter-branch="Filter branch"
      data-text-filter-tag="Find tag"
      data-text-default-branch-label="default"
      data-text-create-tag="Create tag %s"
      data-text-create-branch="Create branch %s"
      data-text-create-ref-from={'from "%s"'}
      data-text-no-results="No results found."
      data-text-view-all-branches="View all branches"
      data-text-view-all-tags="View all tags"
      data-current-repo-default-branch=""
      data-current-repo-link={props.repoLink}
      data-current-tree-path={props.treePath ?? ""}
      data-current-ref-type={refType ?? ""}
      data-current-ref-short-name={props.active?.ref ?? ""}
      data-ref-link-template={refLinkTemplate}
      data-ref-form-action-template=""
      data-dropdown-fixed-text=""
      data-show-tab-branches="true"
      data-show-tab-tags="true"
      data-allow-create-new-ref="false"
      data-show-view-all-refs-entry={showViewAllRefsEntry ? "true" : "false"}
      data-enable-feed="false"
    >
      {/* the pre-mount dummy — branch_dropdown.tmpl:30-51's exact shape
          ("this code must match the code in BranchTagSelector.vue") */}
      <div class="ui dropdown custom branch-selector-dropdown ellipsis-text-items">
        <div class="ui compact button branch-dropdown-button">
          <span class="flex-text-block gt-ellipsis">
            <Icon name={buttonIcon} />
            <strong class="tw-inline-block gt-ellipsis">{props.active?.ref ?? ""}</strong>
          </span>
          <Icon name="octicon-triangle-down" size={14} class="dropdown icon" />
        </div>
      </div>
    </div>
  );
}
