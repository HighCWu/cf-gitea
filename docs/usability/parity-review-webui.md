# Parity Review — cf-gitea Web Pages vs Upstream Gitea Templates

Read-only review of the 12 high-traffic page surfaces: our page modules in
`apps/worker/src/ui/pages/*` against the upstream template chain in
`gitea/templates/**` at the pin (`gitea/` @ `fc49368845`, locale
`gitea/options/locale/locale_en-US.json`). Focus: what the **official JS
bundle** drives — element ordering, CSS classes, `data-*` hooks
(`data-global-init`, `data-global-click`, `data-clipboard-*`, `data-fetch-*`,
`data-tooltip-content`), aria/labels, octicons, and empty-state/locale texts.
Golden tests pin our bytes, so class/attribute drift against the bundle is
invisible to them; that is what this review hunts.

**Not reviewed here (already covered elsewhere):** shell head/foot, asset
wiring, git-HTTP and API surfaces.

## Severity legend

| Severity | Meaning |
|---|---|
| **breaks-bundle-JS** | A hook the bundle dereferences is present-but-miswired on a page we render; real-browser behavior silently breaks (not visible in goldens). |
| **parity** | An upstream element/feature is missing (or reshaped) — behavioral gap, whether or not documented in the module header. |
| **cosmetic** | Byte/label/icon/heading drift with no behavioral hook affected. |

Overall posture finding: **no hard bundle-JS breakage found.** Our pages use
the "omit the JS island entirely" pattern, and every bundle entry point we
verified guards its own absence (`showLineButton` returns when
`.code-line-menu` is missing; `initSingleCommentEditor` is only invoked when a
`.combo-markdown-editor` exists; `initRepoIssueListCheckboxes` only binds via
a `data-global-init` checkbox we never emit). The cost of that posture is the
opposite problem: bundle-driven behaviors are **silently absent** where the
markup contract could arm them at near-zero risk (copy buttons, ellipsis
toggles, fetch-action forms). Those are graded `parity`, and the top-10 ranks
them by real-browser impact.

---

## Top 10 (ranked by real-browser impact)

1. **Repo home — branch selector is a bare Fomantic `.ui.dropdown`, not
   upstream's Vue `initRepoBranchTagSelector`.** Upstream
   (`templates/repo/branch_dropdown.tmpl:24-28`) renders a container with
   `data-global-init="initRepoBranchTagSelector"` and ~20 `data-text-*` /
   `data-current-*` / `data-ref-link-template` attributes; ours
   (`apps/worker/src/ui/components/branch-selector.tsx:44-53`) emits a plain
   `.ui.dropdown` and relies on `initGlobalDropdown`
   (`web_src/js/features/common-page.ts:56-58` enhances `.ui.dropdown:not(.custom)`),
   so the menu opens, but there is no Branches/Tags tab strip, no filter box,
   no "default branch" label, no View-all-branches entry, no
   `octicon-git-branch`/`-tag`/`-commit` glyph on the button, no create-ref
   arm. Affects the repo home, file view AND commits pages (every selector
   consumer). — **parity**
2. **Repo home — the right button-row is the clone panel only.** Upstream
   `templates/repo/view_content.tmpl:44-51` renders the file search box
   (`.repo-file-search-container` + `data-global-init="initRepoFileSearch"`
   + `<kbd>T</kbd>` — the "Go to file" jump, a headline keyboard feature),
   and on the root also the template-library button, Add-File dropdown and
   kebab menu; ours (`pages/home.tsx:362-380`) renders none of them (the
   module comment documents only the file-search deferral). — **parity**
3. **Issues list — the upstream toolbar/filters skeleton is absent.**
   Upstream `templates/repo/issue/list.tmpl:34-56` renders `#issue-filters`
   (`issue-list-toolbar`) with the select-all checkbox
   (`data-global-init="initRepoIssueListCheckboxes"`), openclose tabs and the
   filter dropdown column, plus the hidden `#issue-actions` panel; ours
   (`pages/issues-list.tsx:542-553`) floats `OpenCloseTabs` bare in the
   container with no toolbar wrappers, no checkboxes, no filters. Also: the
   Labels and Milestones buttons (`list.tmpl:28-29`) are unrendered although
   both target pages exist (`pages/repo-labels.tsx`, `pages/milestones.tsx`)
   — dead-link no longer applies; and the **pulls list renders no
   New-Pull-Request button at all** (`list.tmpl:33-35` does; ours gates the
   whole `list-header` on `listKind === "issues"`,
   `issues-list.tsx:535`) — undocumented. — **parity**
4. **Issue/PR detail — timeline event anchors drift from upstream's tag
   scheme and duplicate a DOM id.** Upstream puts the row id `issuecomment-{id}`
   on the `div.timeline-item.event` and `event-{id}` on the inner time anchor
   (`models/issues/comment.go:553-565` — `HashTag` vs `EventTag`;
   `comments.tmpl:81-83,94-96,107-109`); ours puts `event-{comment.id}` on
   BOTH the div and the anchor (`pages/issue-detail.tsx:857,874`), which is
   invalid HTML (duplicate id) and breaks `#issuecomment-N` deep links into
   events. — **parity + invalid DOM**
5. **Issue/PR detail — merge box omits the bundle hook and the closed-PR
   state.** Upstream `pull_merge_box.tmpl:4` carries
   `data-global-init="initRepoPullMergeBox"` (the mergeability poller) and
   renders for every non-archived PR including a closed-state info item
   (`ClosedInfoTitle` arm, `pull_merge_box.tmpl:20-32`); ours
   (`pages/issue-detail.tsx:886-912`) renders no `data-global-init` and hides
   the box entirely once closed/merged (`IssueDetailPage:1167`
   `!isClosed && !hasMerged`), so a closed PR loses its "branch already
   merged / can be deleted" context. Also the pull-desc line drops "N
   commits from" (`repo.pulls.title_desc` —
   `view_title.tmpl` + locale) and has no branch links. — **parity**
6. **Commits list — the trailing actions column is missing.** Upstream
   `templates/repo/commits_list.tmpl:14,60-79` renders a fifth `one wide`
   cell per row with copy-commit-id (`data-clipboard-text` + `octicon-copy`
   — the clipboard bundle handles `data-clipboard-text` globally,
   `web_src/js/modules/clipboard.ts`), view-single-diff and
   view-commit-path buttons; ours (`components/commit-list.tsx:41-82`)
   renders four columns and none of the buttons. The ellipsis toggle
   (`onRepoEllipsisButtonClick`), commit bodies, statuses and the search form
   segment (`commits_table.tmpl:19-31`) are also unrendered. — **parity**
7. **File view — the file-actions row is a subset.** Upstream
   `templates/repo/view_file.tmpl:29-77`: Permalink button (branch/tag),
   Download (`octicon-download`), RSS, source/rendered toggle
   (`.file-view-toggle-buttons` `?display=source`), escape/unescape buttons,
   and the `.code-line-menu.tippy-target` right-click line menu
   (`view_file.tmpl:135-144`: reference-in-new-issue, view-git-blame,
   copy-line-permalink — the bundle's line-selection machinery updates these
   live, `web_src/js/features/repo-code.ts:19-71`). Ours
   (`components/file-content.tsx:241-279`) renders Raw/Blame/History + a
   text-only "Copy" button; `#L1-L3` hash selection still works (guarded),
   but the context menu and its three features are silently absent. Root also
   lacks `TabSizeClass` (`view_file.tmpl:2`). — **parity**
8. **Empty repo page — wrong arm for non-writers.** Upstream
   `templates/repo/empty.tmpl:27,72-73` shows the Quick Guide ONLY to
   `CanWriteCode` viewers; everyone else gets
   `{{ctx.Locale.Tr "repo.empty_message"}}` ("This repository does not have
   any content.") in a centered segment. Ours (`pages/home.tsx:273-343`,
   `EmptyRepoPage`) renders the writer quickstart — clone combo, git
   commands — to **anonymous viewers** on any public empty repo. —
   **parity (undocumented)**
9. **Releases — source-archive download rows are a stale reduction.** The
   module header defers `/archive/{tag}.zip|tar.gz` ("the web-shape archive
   route does not exist", `pages/releases.tsx` header), but the route landed
   (`pages/archive-files.ts`) and the repo-home clone panel already links it
   (`pages/home.tsx:127-132`). Upstream renders "Source Code (ZIP)" /
   "(TAR.GZ)" rows (`release/list.tmpl:96-104`,
   `repo.release.source_code`). Ours renders attachments only
   (`releases.tsx:918-925`). — **parity (stale note)**
10. **Shared repo header (all 12 repo pages) — tab strip drift.** Upstream
    `templates/repo/header.tmpl:104-106` gives the Issues tab
    `octicon-issue-opened` — ours renders no icon
    (`shell.tsx:562-565`); Projects uses `octicon-project` upstream vs our
    allowlisted `octicon-project-symlink` (`shell.tsx:613`); upstream shows a
    repo-admin Settings tab with `item-flex-space`
    (`header.tmpl:186-190`) — ours omits it although the settings pages are
    landed (`pages/repo-settings-*.tsx`); the Code tab href preserves the
    current ref upstream (`header.tmpl:100-101`) vs our bare repo link; and
    our "Created \<date\>" secondary-info (`shell.tsx:549-554`) is a
    cf-gitea addition with no upstream analog. — **cosmetic + parity
    (Settings tab)**

---

## Per-page drift tables

### 1. Repo home (`pages/home.tsx`, `components/file-list.tsx`) vs `repo/home.tmpl`, `repo/view_content.tmpl`, `repo/view_list.tmpl`, `repo/clone_panel.tmpl`, `repo/home_sidebar_top.tmpl`, `repo/empty.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| Branch selector | `.ui.dropdown` generic | `branch_dropdown.tmpl:24-28` Vue island, `data-global-init="initRepoBranchTagSelector"` + ~20 data attrs | **parity** (Top-10 #1) |
| File search "Go to file" | absent | `view_content.tmpl:44-51` `data-global-init="initRepoFileSearch"`, `data-tree-list-url`, `<kbd>T</kbd>` | **parity** (Top-10 #2) |
| New-pull-request button (`#new-pull-request`) | absent | `view_content.tmpl:32-35` | **parity** |
| Add-File dropdown / template button / kebab menu | absent (root) | `view_content.tmpl:52-99` | **parity** (writer features) |
| Breadcrumb copy-path button | absent (dir views) | `view_content.tmpl:38-40` `btn interact-fg` `data-clipboard-text="{{$.TreePath}}"` | **parity** |
| File-tree sidebar on tree views | absent (blob views only, static `ul`) | `view_file_tree.tmpl` `#view-file-tree` with `data-repo-link`/`data-tree-path`/`data-current-ref-name-sub-url` (Vue `repo-view-file-tree.ts`), toggle `data-global-click="onRepoViewFileTreeToggle"` | **parity** |
| `.repo-view-content-data` title div | absent | `view_content.tmpl:2` — read by `ViewFileTreeStore.ts:46-49` | cosmetic |
| Sub-menu counts strip (commits/branches/tags) | absent | `sub_menu.tmpl` rendered by `view_content.tmpl:3` | **parity** |
| `code/upstream_diverging_info` | absent | `view_content.tmpl:110` | **parity** |
| Latest-commit box | `.grey.commit-summary` with author span inside; no avatars/sign/statuses/ellipsis | `latest_commit.tmpl:8-23` (AvatarStackWithNames, ellipsis button `data-global-click="onRepoEllipsisButtonClick"` + hidden `pre.commit-body`) | **parity** (no body expansion) |
| Clone panel | HTTPS-only; button/popup/tabs/URL field match `clone_panel.tmpl` incl. `data-global-init="initRepoClonePanel"`, `.js-clone-url`, `data-clipboard-target`, immediate-nextElementSibling popup — bundle contract intact (`repo-common.ts:76-135`) | Tea CLI tab + editor-apps arm unrendered; `.bundle` archive absent | documented **parity** |
| Sidebar (top) | code-search form verbatim (`home_sidebar_top.tmpl:2-10` classes match) | description/website/topics/manage-topic/README link/license/size/stars/watchers/forks unrendered | documented **parity** |
| Sidebar (bottom) | absent | `home_sidebar_bottom.tmpl` latest release + language stats | documented **parity** |
| `#repo-files-table` | ID + `data-fetch-url/-trigger/-sync/-indicator` arm match `view_list.tmpl:3-8`; row classes `repo-file-item`/`repo-file-cell name muted-links`/`message commit-summary`(+`notready`)/`age` match | submodule rows render `name @ sha` plain vs upstream submodule web-link (`view_list.tmpl:52-63`); symlink `entry-symbol-link` absent | documented **parity** |
| Empty repo (writer arm) | Quick Guide matches `empty.tmpl:28-68` incl. `js-clone-url` spans; `git checkout -b` only when default ≠ master | Non-writer arm wrong (Top-10 #8); New-File/Upload buttons absent | documented **parity** + Top-10 #8 |
| `page-content` class | `repository file list` | same (`home.tmpl:3`) | OK |

### 2. File view (`pages/file-view.tsx`, `components/file-content.tsx`) vs `repo/view_file.tmpl`, `repo/file_info.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| Root enhancement | `data-global-init="initRepoFileView"` + `data-raw-file-link` match `view_file.tmpl:2-3` | `TabSizeClass` missing on root class | cosmetic |
| Commit box | `#repo-file-commit-box` + `.latest-commit` + `tw-text-text-light age` match `view_file.tmpl:11-22` | same subset gap as repo home latest-commit box | **parity** (body) |
| File header left | `file-info` entries (symlink/lines/size + LFS badge `ui label`) match `file_info.tmpl`; but header shows a `octicon-file` glyph + bare filename where upstream shows only `file_info` entries (Readme arm uses `octicon-book`, ours `octicon-file`, `file-content.tsx:213,222`) | `view_file.tmpl:31-36`, `file_info.tmpl` | cosmetic (icon) |
| File actions | Raw / Blame / History + text "Copy" with `data-global-click="onCopyContentButtonClick"` | Permalink, Download, RSS, source/rendered toggle, escape buttons, `octicon-copy` glyph, pencil/trash tooltips verbatim | **parity** (Top-10 #7) |
| Copy button | renders the word "Copy" instead of the icon (allowlist note) — the hook `onCopyContentButtonClick` is correctly registered | `view_file.tmpl:63-66` | cosmetic |
| `.code-line-menu` | absent (guarded in bundle — no break) | `view_file.tmpl:135-144` | **parity** (Top-10 #7) |
| code-view rows | `lines-num` span id/`data-line-number` + `rel` + `lines-code chroma` + `code-inner` match `view_file.tmpl:113-121` | unicode-escape toggle TD (`RenderUnicodeEscapeToggleTd`) absent | cosmetic |
| too-large / empty / view-raw | texts match locale (`repo.file_too_large` variant — ours uses "The file is too large to be shown."; media tags + `file-view-raw-prompt` match) | `shared/filetoolarge`, `shared/fileisempty` | OK |
| `page-content` class | `repository file list view file` on blobs | upstream has no `view file` class at this pin (`view.tmpl:3`) | cosmetic |
| Tree sidebar | static `ul.repo-view-file-tree` (no toggle button, no `is-loading`, no data attrs) | `view_file_tree.tmpl:3-21` | **parity** |

### 3. Commits list (`pages/commits.tsx`, `components/commit-list.tsx`) vs `repo/commits.tmpl`, `repo/commits_table.tmpl`, `repo/commits_list.tmpl`, `base/paginate.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| Button row | BranchSelector + Commit-Graph button (`ui basic small compact button`, octicon-git-branch) match `commits.tmpl:19-23` | selector gap as Top-10 #1 | **parity** |
| Sub-menu counts | absent | `commits.tmpl:6` | **parity** |
| Search segment | absent | `commits_table.tmpl:19-31` (form + `commits_search_dropdown` + tooltip button) | **parity** |
| Header line | plain "Commits" | count + `repo.commits.commits` (or `no_commits`/`nothing_to_compare` arms) `commits_table.tmpl:2-10` | cosmetic |
| Table | `#commits-table` / `tbody.commit-list` / `author` / `sha` (`ui label commit-id-short`) / `message` (`message-wrapper`>`commit-summary`) match; "SHA1" header matches `ToUpper ObjectFormatName` | 5th actions column missing (Top-10 #6); merge commits lack ` grey text` class (`commits_list.tmpl:57`); sign badge slot empty; ellipsis/body absent | **parity** + cosmetic |
| Pagination | Newer/Older only, `center page buttons` + `ui borderless pagination menu` | `base/paginate.tmpl` first/prev/numbered/next/last | cosmetic |

### 4. Commit detail (`pages/commit-view.tsx`) vs `repo/commit_page.tmpl`, `repo/page/commit.tmpl`, `repo/diff/stats.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| Header segment | `.ui.top.attached.header.segment` + `commit-summary` h3 + Browse Source button — order and classes match `page/commit.tmpl:5-12,137-140` | `tw-align-middle` on commit-summary; commit_statuses slot empty (documented) | cosmetic |
| Operations dropdown | absent (documented writer island) | `page/commit.tmpl:16-128` | documented **parity** |
| Identity bar | `ui attached segment flex-text-block tw-flex-wrap` + committed/authored sentences + parents/commit `ui label commit-id-short` — matches `page/commit.tmpl:131-172` incl. `flex-text-inline tw-text-text-light` | copy-hash button missing: `data-clipboard-text="{{.CommitID}}"` + `octicon-copy` (`page/commit.tmpl:166-168`); sign badge slot | **parity** |
| Short-stat segment | `ui attached segment flex-left-right` + TrN files-changed + DiffStats (stats.tmpl shape incl. `+0.0` guard) — matches `page/commit.tmpl:174-178` + `stats.tmpl` | `data-tooltip-content` on `.diff-stats-bar` missing (`stats.tmpl:11`) | cosmetic |
| Branches/tags contained switcher | endpoint landed (`commit-contained-refs.ts`) but no `...` button | `commit_load_branches_and_tags.tmpl` (fetch island) | documented **parity** |
| Diff boxes | shared with pull-files (see §7) — structure matches `diff/box.tmpl` reduce | git-notes section absent (documented) | documented **parity** |
| `page-content` class | `repository diff` | same (`page/commit.tmpl:4`) | OK |

### 5. Issues list (`pages/issues-list.tsx`) vs `repo/issue/list.tmpl`, `shared/issuelist.tmpl`, `repo/issue/openclose.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| Toolbar skeleton | openclose tabs bare in container | `#issue-filters.issue-list-toolbar` (`filters.tmpl:1-16`) + hidden `#issue-actions` (`list.tmpl:38-56`) — the bundle's checkbox machinery targets both (`repo-issue-list.ts:15-44`) | **parity** (Top-10 #3) |
| Select-all / row checkboxes | absent (bundle init never fires — safe) | `filters.tmpl:4`, `issuelist.tmpl:11-13` | documented **parity** |
| Search + Labels/Milestones buttons | absent; **labels/milestones pages are landed** | `list.tmpl:25-29` | **parity** (Top-10 #3) |
| New Issue / New Pull Request | New Issue on issues list only; **pulls list has no button** | `list.tmpl:30-45` renders `repo.pulls.new` (or compare-general on archived) | **parity** (undocumented) |
| Open/close tabs | classes `small-menu-items ui compact tiny menu` + `active item flex-text-inline` + icons match `openclose.tmpl`; counts raw digits (upstream PrettyNumber) | — | cosmetic |
| Row structure | `.item`/`.item-leading`/`.item-main`/`.item-header`/`list-item-large-title`/`.labels-list`/`.item-body`/`.index`/`.milestone`/`.item-trailing` all match `issuelist.tmpl` | PR rows lack `.branches` base→head links (`issuelist.tmpl:78-96`); milestone renders plain text (upstream links `/milestone/{id}` + `octicon-milestone` — page now landed, note stale); assignee avatars/approvals/checklist/due-date/project/ref chips absent (documented reductions) | **parity** + stale note |
| Comment count | number only, links to detail | `issuelist.tmpl:145+` number + `octicon-comment`-less avatar list (assignees) | cosmetic |
| Empty state | invented "No results / Try adjusting your search filters." (`tw-text-center tw-p-8`) | upstream list has no such empty card; `{{else}}` arm of `shared/repo/list.tmpl` uses `search.no_results` ("No matching results found.") | cosmetic (text not in locale) |
| `page-content` class | `repository issue-list` | same (`list.tmpl:3`) | OK |

### 6. Issue/PR detail (`pages/issue-detail.tsx`) vs `repo/issue/view.tmpl`, `view_title.tmpl`, `view_content.tmpl`, `comments.tmpl`, `pull_merge_box.tmpl`, `sidebar.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| `page-content` class | `repository view issue pull` unconditional | same (`view.tmpl:3`) | OK |
| `#issue-page-info` | absent | `view_title.tmpl:3-8` (`data-issue-index/-repo-link/-repo-id`; read by bundle utils) | **parity** |
| Title bar | `issue-title-header`/`issue-title`/`h1` + `.index` span match; Edit/New buttons absent (documented write actions) | `view_title.tmpl:11-31` | documented **parity** |
| State badge | exact label/icon/color pairs incl. merged-purple/git-merge, draft-grey — matches `view_title.tmpl:44-62` | — | OK |
| Meta line | "opened {time} by {poster}" + comment count matches `opened_by`/`num_comments`; poster anchors profile (namelink parity) | — | OK |
| Pull-desc | `wants to merge <code>head</code> into <code>base</code>` — no commit count, no `id="branch_target"`, no branch links | `repo.pulls.title_desc` (`view_title.tmpl:97-103`) | documented **parity** |
| Tab menu | `ui pull tabs container` + `ui top attached pull tabular menu` + 3 tabs + counts ("-") — matches `pulls/tab_menu.tmpl` shape; icons absent (allowlist note) | — | documented cosmetic |
| Root comment | `#issue-{id}` on `.timeline-item.comment.issue-content-comment` — matches `HashTag()` (`issue.go:432-434` is ID-based, NOT index) | header lacks `.comment-header-right` (show_role/context menu) and `data-can-edit` on `.render-content` (documented) | documented **parity** |
| Timeline events | badges `tw-bg-green/red/purple tw-text-white` + icons match `comments.tmpl:81-109`; **ids drift** (Top-10 #4); merge event renders short-sha plain text vs upstream `.ui.sha` commit link (`comments.tmpl:113-118`) | — | **parity** (Top-10 #4) |
| Merge box | summary text lines match locale (`repo.pulls.no_merge_wip`, Vue-form sentences); **no `data-global-init="initRepoPullMergeBox"`, closed PRs get no box** | `pull_merge_box.tmpl:4,20-32` | **parity** (Top-10 #5) |
| Comment form | `#comment-form` + `#status-button` (`name="status"`, icon+`status-button-text` span — matches `view_content.tmpl:86-107` pair colors) + `#comment-button`; anonymous/archived/locked arms match the template ladder | form lacks `form-fetch-action` class (inline POST morph) and the combo markdown editor (`.combo-markdown-editor`) — so `initSingleCommentEditor` never engages; `data-status`/`data-status-and-comment` attrs absent (inert without the combo editor — verified `repo-issue.ts:444-457,509-511`) | documented **parity** |
| Sidebar | `.issue-content-right.ui.segment`, labels list (`issue-sidebar-combo` + `fixed-text muted`), milestone link `octicon-milestone` — reduced but faithful; no-JS label form carries upstream `issue_ids`/`label_ids` field names | edit dropdowns/milestones picker/reviewers-JS are write islands (documented); Assignees/Participants/Notify sections absent | documented **parity** |
| `timeline-comments-end` marker | present, `tw-hidden` — matches `view_content.tmpl:96` | — | OK |
| Reactions / attachments / content-history dropdown | absent | `shared/reactions`, `attachments.tmpl` | documented **parity** |

### 7. PR detail + files (`pages/pull-files.tsx`, shared title/tabs) vs `repo/pulls/files.tmpl`, `repo/diff/box.tmpl`, `section_unified.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| `page-content` class | `repository view issue pull files diff` | same (`pulls/files.tmpl:3`) | OK |
| Toolbar | `.diff-detail-box` + `flex-text-block tw-flex-wrap tw-ml-0.5` + `.diff-detail-stats` text matches `box.tmpl:5,17-20`; missing `octicon-diff` glyph | `box.tmpl:18` | cosmetic |
| File-tree / commit-select / viewed-files / whitespace+options dropdowns / new-review | absent (documented JS islands; `initDiffFileTree`, `initDiffCommitSelect` hooks unrendered) | `box.tmpl:22-73` | documented **parity** |
| File box | `.diff-file-box.file-content` id `diff-{hash}` + `data-old/new-filename` + `.diff-file-header.sticky-2nd-row` + `.diff-file-body.ui.attached.unstackable.table.segment` match `box.tmpl:95-110` | fold-file button (`data-global-click="diffFileViewFold"`), copy-path (`data-clipboard-text`), LFS/Generated/Vendored labels, `TabSizeClass`, `data-folded` absent | **parity** |
| Unified table | colgroup 50/50/10/10/auto; `tr.{add,del,same,tag}-code` + `data-line-type`; `lines-num-old/new` + `rel="diff-{hash}L/R{n}"`; `lines-escape`/`lines-type-marker`/`chroma lines-code` + `code-inner`; hunk `blob-hunk` row — matches `section_unified.tmpl` reduce | excerpt/comment/whitespace-escape button cells empty by design | documented cosmetic |
| Degraded bodies | binary/too-large/mode/whitespace texts match locale (`repo.diff.bin_not_shown` etc.) | — | OK |
| DiffNotAvailable | `<h4>Diff Content Not Available</h4>` | `box.tmpl:79-80` | OK |
| Rename metadata | `data-old-filename` = new path (no rename detection — documented) | `box.tmpl:107-109` old → new | documented **parity** |

### 8. Branches (`pages/branches.tsx`) vs `repo/branch/list.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| `page-content` class | `ui repository branches` | same (`list.tmpl:3`) | OK |
| Sections | default-branch h4 + table/`branches-default-branch-not-exist` segment + Branches h4 + search segment + table — order and `data-testid` attrs match `list.tmpl:7-79` (upstream carries the same `data-testid`) | — | OK |
| Switch Default Branch link | admin-gated, renders the TEXT (icon allowlist) | `list.tmpl:12-17` IsWriter + `octicon-arrow-switch` icon-only | documented **parity**/cosmetic |
| Row name cell | `.gt-ellipsis.branch-name` + shield badge — matches | **copy-branch button missing** (`data-clipboard-text` + `octicon-copy`, `list.tmpl:45,123`); added "Default" `ui basic label` (cf-gitea addition, documented); rule-name tiny label addition (documented) | **parity** + documented additions |
| `p.info` line | octicon-git-commit + ShortSha link + subject + Updated + author — matches `list.tmpl:47` shape | pusher avatar/namelink absent (documented) | documented cosmetic |
| Divergence cell | `.commit-divergence` bar-group/count/bar classes + tooltips match; 0/0 NaN→0% (documented improvement) | — | OK |
| PR cell | four arms (Included / compare / #N + state labels) match `list.tmpl:110-155` incl. `ref-issue` class and label colors | cross-repo FullName prefix absent (documented — no forks) | documented **parity** |
| Actions cell | create/rename as inline no-JS forms POSTing upstream's exact routes (`/branches/_new/branch/{from}`, `/branches/rename`); delete as direct POST `/branches/delete` | upstream `show-create-branch-modal`/`showRenameBranchModal`/`delete-branch-button` modal buttons + `data-modal-*` attrs (JS modals); RSS/Download dropdowns + restore absent (documented) | documented **parity** |
| thead | added (additive a11y; upstream thead-less) | — | cosmetic |
| Sub-menu counts | absent | `list.tmpl:6` | **parity** |

### 9. Releases (`pages/releases.tsx`) vs `repo/release/list.tmpl`, `label.tmpl`, `release_tag_header.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| Header | `.flex-left-right` counts menu (`ui compact small menu small-menu-items`, Releases active + `{N} Tags`) + New Release button — matches `release_tag_header.tmpl` | RSS button absent (documented) | documented cosmetic |
| Entry | `.release-entry`/`.meta` tag+commit links / `.ui.segment.detail` / `release-list-title` + label / author+`released this`+time / `.render-content.markup` / divider / `<details class="download" open>` first entry — matches `list.tmpl:10-95` | `h3` vs upstream `h4` (documented a11y); compare branch-dropdown (`initRepoBranchTagSelector` island) absent; ahead/behind line absent (documented; upstream inert at num_commits 0) | documented **parity** |
| Labels | IsLatest→Draft→Prerelease→Stable order/colors match `label.tmpl` | — | OK |
| Downloads | attachment rows match (`octicon-package download-icon`, size, download-count tooltip, time) | **Source Code ZIP/TAR.GZ rows missing although `/archive/*` now serves** (Top-10 #9) | **parity** (stale note) |
| Detail page | SingleRelease = same template over one row — matches `release.go:335` posture | — | OK |

### 10. Org home (`pages/org-home.tsx`) vs `org/home.tmpl`, `org/header.tmpl`, `org/menu.tmpl`, `shared/repo/list.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| `page-content` class | `organization profile` | same (`home.tmpl:3`) | OK |
| Header | `ui container flex-container` + avatar slot (placeholder octicon-organization) + `tw-text-2xl` name + limited/private `ui large basic horizontal label` + description + location/website/email rows — matches `org/header.tmpl` | avatar `<img>` (no pipeline — documented); email gate matches signed-in check | documented cosmetic |
| Menu | single Repositories tab + optional projects/packages tabs; `overflow-menu ui secondary pointing tabular borderless menu tw-mb-4` matches `menu.tmpl` | Overview (profile-readme), Members/Teams, Settings, worktime tabs absent (documented dead-link rule; members/teams pages exist now — stale for Members) | **parity** (Members tab stale) |
| Repo list | shared row matches `shared/repo/list.tmpl` (badges, updated line, pulls chip) | stars/forks/primary-language chips, topics row, owner-name prefix absent (documented §3.1); upstream `{{else}}` arm uses `search.no_results`, ours uses home.tmpl's empty-placeholder — matches home.tmpl instead | documented **parity** |
| Sidebar column | absent (single column) | `home.tmpl:9-15` eleven/five-wide grid: new-repo/migrate buttons, view-as dropdown, members avatars, teams cards, create-team | documented **parity** |
| Search box | absent | `shared/repo/search.tmpl` (`data-global-init="initRepositorySearch"` + filter/sort dropdowns) | documented **parity** |
| Empty state | `.empty-placeholder` + octicon-repo 48 + `org.repos.empty`/`empty_description` — texts verified against locale | — | OK |

### 11. User profile (`pages/user-profile.tsx`) vs `user/profile.tmpl`, `shared/user/profile_big_avatar.tmpl`, `user/overview/header.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| `page-content` class | `user profile` | same (`profile.tmpl:2`) | OK |
| Grid | `ui stackable grid` four-wide + twelve-wide columns match `profile.tmpl:8-38` | — | OK |
| Avatar card | `#profile-avatar-card .ui.fitted.segment` + followers/following anchors (`?tab=followers` with 18px octicon-person) + location/website/description/Joined-on rows — matches `profile_big_avatar.tmpl` reduce | avatar `<img>`, follow/block buttons, admin gear, email row, org row absent (documented) | documented **parity** |
| Visibility badge | rendered for users too | upstream badges org profiles only at this pin — documented intentional divergence | documented cosmetic |
| Tabs | Repositories (active) + Packages + Activity (`octicon-rss`) + Starred + Watched — matches `overview/header.tmpl` order; upstream renders Stars/watching only when stars enabled (both-inactive collapse documented) | Overview/Projects/Code tabs absent (documented dead-link rule) | documented **parity** |
| Repo list | shared org-home row | same reductions as org home; no search box | documented **parity** |

### 12. Admin dashboard (`pages/admin-dashboard.tsx`) vs `admin/dashboard.tmpl`, `admin/layout_head.tmpl`, `admin/navbar.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| `page-content` class | `admin dashboard` | same (`layout_head` pageClass) | OK |
| Layout | fluid padded flex-container + AdminFamilyNav (reduced navbar: Maintenance group w/ Dashboard + Monitoring items) + `.flex-container-main` > `.admin-setting-content` | navbar groups Identity&Access/Code Assets/Integrations/Actions/Config/Notices omitted (every item an unlanded page — documented) | documented **parity** |
| NeedUpdate message | absent (no update checker — honest false-arm) | `dashboard.tmpl:3-7` | documented **parity** |
| Maintenance ops | ONE live row (`update_mirrors`) with Run button POSTing `op=` to `/-/admin` (upstream's exact form target + `name=op` shape); fixed 13-op list renders as a posture paragraph | `dashboard.tmpl:11-72`; `octicon-play` glyph omitted (allowlist) | documented **parity** |
| System status | header + segment with honest-absence paragraph; `GET /-/admin/system_status` fragment unmounted | `dashboard.tmpl:74-80` + `system_status.tmpl` dl + `data-fetch-url` 5s morph | documented **parity** |

### 13. Explore (`pages/explore.tsx`) vs `explore/repos.tmpl`, `explore/users.tmpl`, `explore/navbar.tmpl`, `explore/user_list.tmpl`, `shared/repo/search.tmpl`

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| `page-content` class | `explore repositories` / `explore users` (orgs page carries users class) | same (`repos.tmpl:3`, `users.tmpl:3`) | OK |
| Navbar | `overflow-menu ui secondary pointing tabular top attached borderless menu secondary-nav` + `overflow-menu-items tw-justify-center` + 4 tabs (repos/users/organizations/code) — classes match `navbar.tmpl` | Code tab gated on `IsRepoIndexerEnabled` upstream; ours ungated (documented SPEC-0019 posture) | documented **parity** |
| Search | `ui small secondary filter menu` + `ui small fluid action input` + `input[type=search] name=q maxlength=255` matches `shared/search/combo.tmpl`; **submit button renders the text "Search…" instead of `octicon-search`** (upstream `shared/search/button.tmpl` icon-only with `aria-label="Search…"`) | filter/sort dropdowns absent (documented) | documented **parity** + cosmetic |
| Repo rows | shared org-home row reduction | same documented gaps as org home (stars/forks/language/topics) | documented **parity** |
| User rows | avatar placeholder + name link + Private badge + location + Joined-on — matches `user_list.tmpl` shape | email row gated on ShowUserEmail upstream (default-off — ours absent, consistent) | documented cosmetic |
| Empty state | `search.no_results` ("No matching results found.") — matches upstream `{{else}}` arms | — | OK |
| Pagination | Newer/Older; upstream full numbered paginate | — | cosmetic |

### Cross-page shared chrome (affects all repo pages)

| Area | Ours | Upstream (cite) | Severity |
|---|---|---|---|
| Repo header badges | Public Access (orange) / Private match; archived/internal/template/sha256 badges + mobile icons absent | `header.tmpl:24-49` | documented **parity** |
| Watch/Star/Fork trio | fetch-action wired (`data-fetch-method`/`data-fetch-url`/`data-fetch-sync`) — bundle contract engaged; watch modes reduced to 2 (documented); RSS button absent | `header.tmpl:63-78` | documented **parity** |
| Repo switcher | absent | `header.tmpl:15-21` `data-global-init="initRepoSwitcher"` | **parity** (signed-in convenience) |
| Tab strip | see Top-10 #10 | — | — |
| Relative time | `<relative-time>` web component with `tense`/`datetime`/tooltip attrs — matches bundle's `tippy`/`relative-time` expectations | — | OK |
| Pagination shape | all pages use Newer/Older; upstream `base/paginate.tmpl` numbered pager everywhere | — | cosmetic |

---

## Verification notes

- Every bundle hook cited was checked in `gitea/web_src/js` at the pin:
  `initRepoClonePanel`/`initRepoCloneButtonsCombo` (features/repo-common.ts),
  `initRepoBranchTagSelector` (components/BranchTagSelector.vue), global
  `.ui.dropdown` enhancement (features/common-page.ts initGlobalDropdown),
  `initRepoFileSearch` (features/repo-findfile.ts), `#status-button`
  data-attr swap (features/repo-issue.ts initSingleCommentEditor — engages
  only with `.combo-markdown-editor`), `initRepoIssueListCheckboxes`
  (features/repo-issue-list.ts — binds only via its own `data-global-init`),
  `data-clipboard-text`/`data-clipboard-target` (modules/clipboard.ts),
  `showLineButton`'s missing-menu guard (features/repo-code.ts),
  `.repo-view-content-data` (components/ViewFileTreeStore.ts),
  `[data-shortcut-keys]` (modules/shortcut.ts).
- Locale strings verified against `gitea/options/locale/locale_en-US.json`
  (flat key:value at this pin): clone-panel texts, issue/PR state labels,
  merge-box sentences, diff degradations, release labels, org/user empty
  states, `repo.empty_message`, tab labels — all match. Two invented texts
  flagged: issues-list empty card ("No results / Try adjusting your search
  filters.") and the admin-dashboard posture paragraphs (deliberate).
- Hash-tag semantics verified in Go source: `Issue.HashTag()` = `issue-{ID}`
  (not index — ours correct); `Comment.HashTag()` = `issuecomment-{ID}`;
  `Comment.EventTag()` = `event-{ID}` — ours conflates the two (Top-10 #4).
