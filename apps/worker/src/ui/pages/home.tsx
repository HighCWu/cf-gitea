/**
 * The repo browse page (§2.1 home row, §3.3 home wiring): repo header (the
 * shell's RepoHeader), the branch selector, the `#repo-files-table` root
 * listing with the latest-commit box and §3.5 per-entry enrichment, and the
 * README section rendered through the shared §3.4 markdown pipeline.
 *
 * The body rides upstream home.tmpl's `repo-grid-filelist-sidebar` grid:
 * the listing in `.repo-home-filelist` plus the `.repo-home-sidebar-top`
 * column carrying the repo-home code-search form (home_sidebar_top.tmpl:2-10
 * — the GET form toward `{RepoLink}/search`, the ONLY upstream link into the
 * landed search page). The form's markup is byte-faithful to the pin; the
 * `S` shortcut works because the official bundle serves it: the kbd hint's
 * `data-global-init="onGlobalShortcut"` is registered server-bundle-side
 * (web_src/js/modules/shortcut.ts:123) and observer.ts wires the wrapper.
 * The rest of upstream's sidebar_top (description/website/topics/README
 * link/size/stars/watchers/forks) and the whole sidebar_bottom (latest
 * release, language stats) are deferred — each needs data surfaces this
 * unit does not own; the grid already reserves their slots.
 *
 * Empty repos (§4.1: public, unborn HEAD) render upstream repo/empty.tmpl
 * branched on the viewer: writers (the canWriteRepository static arms — the
 * EmptyRepoPage disclosure) get the Quick Guide with the two command-line
 * blocks (the clone URL from the request origin); everyone else the
 * template's single `repo.empty_message` segment — no file list, no README,
 * no sidebar in either arm (upstream's empty.tmpl has none), never a crash
 * on `readCommit(null)`.
 */

import type { CommitJson, TreeEntryJson } from "@cf-gitea/git-engine";

import { BranchSelector, type SelectorRefs } from "../components/branch-selector";
import { FileContentView } from "../components/file-content";
import { RepoFilesTable } from "../components/file-list";
import type { EngineClient } from "../engine";
import { locale } from "../locale";
import { enrichTreeCommits, pickReadme, renderRepoMarkdown } from "../page-data";
import { BaseLayout, Icon } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import { searchPageLocale } from "./repo-search";

/** The empty-repo page's upstream strings (options/locale locale_en-US.json,
 *  the `repo.*` keys — the same values status templates render through
 *  ctx.Locale.Tr). */
const emptyRepoLocale = {
  /** "repo.quick_guide" */
  quick_guide: "Quick Guide",
  /** "repo.clone_this_repo" */
  clone_this_repo: "Clone this repository",
  /** "repo.create_new_repo_command" */
  create_new_repo_command: "Creating a new repository on the command line",
  /** "repo.push_exist_repo" */
  push_exist_repo: "Pushing an existing repository from the command line",
  /** "repo.empty_message" — the non-writer arm (empty.tmpl:74). */
  empty_message: "This repository does not have any content.",
};

/** The clone panel's chrome text (the component-local pattern — locale.ts is
 *  shared and not this wave's file; the panel's "Code" label reuses the
 *  locale module's repo_code value). */
const clonePanelLocale = {
  /** The clone_panel.tmpl header row's plain "Clone" label (upstream
   *  hardcodes it next to the octicon-terminal — no locale key at the pin). */
  clone: "Clone",
  /** "copy_url" */
  copy_url: "Copy URL",
  /** "repo.download_zip" / "repo.download_tar" */
  download_zip: "Download ZIP",
  download_tar: "Download TAR.GZ",
} as const;

/** The HTTPS clone URL for one repo (upstream ComposeHTTPSCloneURL,
 *  models/repo/repo.go:613-615 — `{AppURL}{owner}/{repo}.git`; the request
 *  origin is the AppURL stand-in, the empty-repo page's existing convention). */
export function httpsCloneUrl(origin: string, ownerNamespace: string, slug: string): string {
  return `${origin}/${ownerNamespace}/${slug}.git`;
}

/**
 * The clone dropdown panel (templates/repo/clone_panel.tmpl at the pin,
 * rendered by view_content.tmpl:115 on the repo home's tree root) — the
 * `initRepoClonePanel` button plus the `.clone-panel-popup.tippy-target`
 * sibling the official bundle turns into the click dropdown
 * (web_src/js/features/repo-common.ts:130-141: the popup must be the
 * button's IMMEDIATE nextElementSibling; the combo logic reads the
 * `data-link` tabs, fills every `.js-clone-url` on the page and drives the
 * `data-clipboard-target` copy button — the markup is the whole contract).
 *
 * HTTPS-only is the documented divergence: upstream renders the SSH tab
 * when `SupportSSH` (`!setting.SSH.Disabled && (doer || ExposeAnonymous)`,
 * models/repo/repo.go:672) and a Tea CLI tab — cf-gitea serves no SSH
 * transport, so both tabs are unrendered (the JS falls back to the first
 * available tab, the exact shape upstream's own admin-disabled case
 * produces). OpenWithEditorApps is unrendered (no editor-app config
 * surface, clone_panel.tmpl's `$showOpenWithEditorApps` arm). The download
 * arms ride the LANDED archive route (pages/archive-files.ts, the
 * DownloadArchiveLinkPrefix shape view_home.go:94 builds) — zip + tar.gz;
 * the bundle arm is unrendered (the landed builder refuses the format — a
 * dead link, the dead-link rule).
 */
export function RepoClonePanel(props: { cloneUrl: string; archivePrefix: string }) {
  return (
    <>
      <button type="button" class="ui compact primary button" data-global-init="initRepoClonePanel">
        <Icon name="octicon-code" size={16} />
        <span>{locale.repo_code}</span>
        <Icon name="octicon-triangle-down" size={14} class="dropdown icon" />
      </button>
      <div class="clone-panel-popup tippy-target">
        <div class="flex-text-block clone-panel-field">
          <Icon name="octicon-terminal" /> {clonePanelLocale.clone}
        </div>
        <div class="clone-panel-tab">
          <button type="button" class="item repo-clone-https" data-link={props.cloneUrl}>
            HTTPS
          </button>
        </div>
        <div class="divider" />
        <div class="clone-panel-field">
          <div class="ui input tiny action">
            <input size={30} class="repo-clone-url js-clone-url" value={props.cloneUrl} readonly />
            <div
              class="ui small compact icon button"
              data-clipboard-target=".js-clone-url"
              data-tooltip-content={clonePanelLocale.copy_url}
              aria-label={clonePanelLocale.copy_url}
            >
              <Icon name="octicon-copy" size={14} />
            </div>
          </div>
        </div>
        <div class="flex-items-block clone-panel-list">
          <a class="item muted archive-link" href={`${props.archivePrefix}.zip`} rel="nofollow">
            <Icon name="octicon-file-zip" /> {clonePanelLocale.download_zip}
          </a>
          <a class="item muted archive-link" href={`${props.archivePrefix}.tar.gz`} rel="nofollow">
            <Icon name="octicon-file-zip" /> {clonePanelLocale.download_tar}
          </a>
        </div>
      </div>
    </>
  );
}

/**
 * The inline clone combo (templates/repo/clone_buttons.tmpl — empty.tmpl:39
 * renders it in the quickstart's repo-button-row): the same
 * `initRepoCloneButtonsCombo` contract minus the dropdown — the HTTPS tab
 * button, the readonly url input and the copy button, driven by the same
 * bundle feature (the combo's `data-clipboard-target` scopes to the sibling
 * input's class).
 */
export function RepoCloneButtonsCombo(props: { cloneUrl: string }) {
  return (
    <div class="ui action small input clone-buttons-combo" data-global-init="initRepoCloneButtonsCombo">
      <button type="button" class="ui small button repo-clone-https" data-link={props.cloneUrl}>
        HTTPS
      </button>
      <input size={10} class="repo-clone-url js-clone-url" value={props.cloneUrl} readonly />
      <button
        type="button"
        class="ui small icon button"
        data-clipboard-target=".repo-clone-url"
        data-tooltip-content={clonePanelLocale.copy_url}
        aria-label={clonePanelLocale.copy_url}
      >
        <Icon name="octicon-copy" size={14} />
      </button>
    </div>
  );
}

/** The ref universe + resolved default branch behind one page render. */
export interface ResolvedRefs extends SelectorRefs {
  /** The branch the page renders (`listRefs().head` short name, the §4.9
   *  default-branch fallbacks applied). `null` = unborn/empty repo. */
  headBranch: string | null;
}

/** Resolve `listRefs()` output to the §3.3/§4.9 default branch: the DO's
 *  HEAD when it names an existing branch, else the D1 default branch, else
 *  the first branch, else `null` (unborn — the empty-repo render). */
export function resolveHeadBranch(
  refs: { head: string | null; refs: { name: string; target: string }[] } | null,
  defaultBranch: string,
): ResolvedRefs {
  const branches = (refs?.refs ?? [])
    .filter((r) => r.name.startsWith("refs/heads/"))
    .map((r) => r.name.slice("refs/heads/".length));
  const tags = (refs?.refs ?? [])
    .filter((r) => r.name.startsWith("refs/tags/"))
    .map((r) => r.name.slice("refs/tags/".length));
  const headRef = refs?.head ?? null;
  const headBranch =
    headRef !== null && headRef.startsWith("refs/heads/") && branches.includes(headRef.slice("refs/heads/".length))
      ? headRef.slice("refs/heads/".length)
      : branches.includes(defaultBranch)
        ? defaultBranch
        : (branches[0] ?? null);
  return { branches, tags, headBranch };
}

/** Everything HomePage renders, loaded by loadHomeData. */
export interface HomeData {
  isEmpty: boolean;
  refs: ResolvedRefs;
  /** The root listing; empty on the empty-repo render (§4.1). */
  entries: TreeEntryJson[];
  /** §3.5 per-entry last commits (absent name = beyond the enrichment
   *  budget → `.notready` cell, same as a `null` value). */
  commits: Map<string, CommitJson | null>;
  latestCommit: CommitJson | null;
  readme: {
    entry: TreeEntryJson;
    variant: "markup" | "plain-text";
    html: string;
    /** The decoded source text — the plain-text variant's `<pre>` body. */
    text: string;
  } | null;
}

/** Load the home page's data (§3.2: direct service/RPC calls, no self-fetch).
 *  `null` never happens — every engine failure degrades to the empty-repo
 *  render (§4.1/§4.9), matching the gate's serveHead fall-back posture. */
export async function loadHomeData(engine: EngineClient, repo: RepoRow, origin: string): Promise<HomeData> {
  const empty: HomeData = {
    isEmpty: true,
    refs: { branches: [], tags: [], headBranch: null },
    entries: [],
    commits: new Map(),
    latestCommit: null,
    readme: null,
  };

  const refs = resolveHeadBranch(await engine.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return empty; // §4.1: unborn HEAD

  const head = refs.headBranch;
  const [latestCommit, tree] = await Promise.all([engine.readCommit(head), engine.listTree(head, "")]);
  const entries = tree?.entries ?? [];
  if (entries.length === 0) return { ...empty, refs }; // §4.1: no file list

  const commits = await enrichTreeCommits(engine, head, entries, (entry) => entry.name);

  // §3.3 README: first upstream-detection match, blob read, §3.4 render.
  let readme: HomeData["readme"] = null;
  const readmeEntry = pickReadme(entries);
  if (readmeEntry !== null && (readmeEntry.size ?? 0) <= 512 * 1024) {
    const blob = await engine.readBlob(head, readmeEntry.name);
    if (blob !== null) {
      const text = new TextDecoder().decode(blob.data);
      const html = renderRepoMarkdown({
        text,
        name: readmeEntry.name,
        repo,
        refType: "branch",
        ref: head,
        origin,
      });
      readme = { entry: readmeEntry, variant: html === "" ? "plain-text" : "markup", html, text };
    }
  }

  return { isEmpty: false, refs, entries, commits, latestCommit, readme };
}

/** The §4.1 empty-repo render — upstream repo/empty.tmpl at the pin,
 *  BRANCHED on the viewer like the template: the CanWriteCode arm renders
 *  the `repository quickstart` page with the Quick Guide header, the
 *  "Clone this repository" item and the two command-line items (locale
 *  repo.quick_guide / repo.clone_this_repo / repo.create_new_repo_command
 *  / repo.push_exist_repo; the command blocks carry upstream's exact lines —
 *  `git checkout -b` only when the default branch is not `master`, the
 *  `.js-clone-url` span the official bundle wires); everyone else gets
 *  empty.tmpl:74's single centered segment — `repo.empty_message`
 *  ("This repository does not have any content."). The writer fold is the
 *  canWriteRepository STATIC arms (site admin / the case-folded owner — the
 *  same reduction issues-list.tsx's viewerCanCreatePull carries): the
 *  collaborator-row and team arms need the D1 grant read this render path
 *  does not perform, so a write-granted collaborator sees the message arm —
 *  disclosed; anonymous and plain signed-in readers get upstream's exact
 *  non-writer arm either way. Deferred like the wiki clone-button surface
 *  (pages/repo-wiki.tsx:143): the item's repo-button-row (New File / Upload
 *  File / the clone-button group) needs the CloneButtonOriginLink data +
 *  bundle plumbing this module does not own — the command blocks carry the
 *  same clone URL meanwhile. Upstream's sha256 `--object-format` arm is
 *  omitted: every landed row is sha1. */
export function EmptyRepoPage(props: { ctx: UiContext }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("EmptyRepoPage requires ctx.repo");
  const cloneUrl = `${ctx.origin}/${repo.ownerNamespace}/${repo.slug}.git`;
  const branch = repo.defaultBranch;
  // Upstream renders `git checkout -b <branch>` only when the default is
  // not `master` (empty.tmpl's `{{if ne .Repository.DefaultBranch "master"}}`).
  const checkoutLine = branch === "master" ? [] : [`git checkout -b ${branch}`];
  // empty.tmpl's arm chain (CanWriteCode → guide, else the message). The
  // writer fold mirrors issues-list.tsx's viewerCanCreatePull (the static
  // grant arms — see that function's disclosure).
  const canWriteCode =
    ctx.viewer.kind === "user" &&
    (ctx.viewer.isAdmin || repo.ownerNamespace.toLowerCase() === ctx.viewer.username.toLowerCase());
  if (!canWriteCode) {
    return (
      <BaseLayout ctx={ctx} pageClass="repository quickstart" activeTab="code">
        <div class="ui container">
          <div class="ui grid">
            <div class="sixteen wide column content">
              {/* empty.tmpl:74 verbatim — the non-writer arm's whole body. */}
              <div class="ui segment center">{emptyRepoLocale.empty_message}</div>
            </div>
          </div>
        </div>
      </BaseLayout>
    );
  }
  return (
    <BaseLayout ctx={ctx} pageClass="repository quickstart" activeTab="code">
      <div class="ui container">
        <div class="ui grid">
          <div class="sixteen wide column content">
            <h4 class="ui top attached header">{emptyRepoLocale.quick_guide}</h4>
            <div class="ui attached segment empty-repo-guide flex-relaxed-list">
              <div class="item">
                <h3>
                  {emptyRepoLocale.clone_this_repo}{" "}
                  <small>
                    Need help cloning? Visit{" "}
                    <a target="_blank" rel="noopener noreferrer" href="http://git-scm.com/book/en/v2/Git-Basics-Getting-a-Git-Repository">
                      Help
                    </a>
                    .
                  </small>
                </h3>
                {/* empty.tmpl:39's repo-button-row inside the clone item — the
                    writer's New File/Upload File arms are unrendered (dead
                    links; the editor routes are the file-view family's), the
                    clone combo renders (clone_buttons.tmpl verbatim). */}
                <div class="repo-button-row">
                  <RepoCloneButtonsCombo cloneUrl={cloneUrl} />
                </div>
              </div>
              <div class="divider" />
              <div class="item">
                <h3>{emptyRepoLocale.create_new_repo_command}</h3>
                <div class="markup">
                  <pre>
                    <code>
                      {`touch README.md
git init
${checkoutLine.length > 0 ? checkoutLine[0] + "\n" : ""}git add README.md
git commit -m "first commit"
git remote add origin `}                      <span class="js-clone-url">{cloneUrl}</span>
                      {`
git push -u origin ${branch}`}
                    </code>
                  </pre>
                </div>
              </div>
              <div class="item">
                <h3>{emptyRepoLocale.push_exist_repo}</h3>
                <div class="markup">
                  <pre>
                    <code>
                      {`git remote add origin `}<span class="js-clone-url">{cloneUrl}</span>
                      {`
git push -u origin ${branch}`}
                    </code>
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The repo browse page (§2.4.1 discriminator: `repository file list`). */
export function HomePage(props: { ctx: UiContext; data: HomeData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("HomePage requires ctx.repo");
  if (data.isEmpty) return <EmptyRepoPage ctx={ctx} />;

  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const head = data.refs.headBranch;
  if (head === null) return <EmptyRepoPage ctx={ctx} />;

  const readme = data.readme;
  return (
    <BaseLayout ctx={ctx} pageClass="repository file list" activeTab="code">
      <div class="ui container">
        <div class="repo-grid-filelist-sidebar">
          <div class="repo-home-filelist">
            <div class="repo-button-row">
              <div class="repo-button-row-left">
                <BranchSelector
                  repoLink={repoLink}
                  family="src"
                  refs={data.refs}
                  active={{ refType: "branch", ref: head }}
                />
              </div>
              {/* view_content.tmpl:115's tree-root clone panel — the right
                  group's only landed member (the file search above it is
                  unrendered; the panel is the row's whole right side). */}
              <div class="repo-button-row-right">
                <RepoClonePanel
                  cloneUrl={httpsCloneUrl(ctx.origin, repo.ownerNamespace, repo.slug)}
                  archivePrefix={`${repoLink}/archive/${head}`}
                />
              </div>
            </div>
            <RepoFilesTable
              repoLink={repoLink}
              refType="branch"
              ref={head}
              dirPath=""
              entries={data.entries}
              commits={data.commits}
              latestCommit={data.latestCommit}
            />
            {readme !== null ? (
              <div class="repo-readme-section">
                <FileContentView
                  repoLink={repoLink}
                  treePath={readme.entry.name}
                  ref={head}
                  variant={readme.variant}
                  markupHtml={readme.html}
                  text={readme.text}
                  size={readme.entry.size ?? null}
                  latestCommit={data.commits.get(readme.entry.name) ?? null}
                  readmeInList={true}
                />
              </div>
            ) : null}
          </div>
          <div class="repo-home-sidebar-top flex-relaxed-list">
            {/* home_sidebar_top.tmpl:2-10 verbatim + shared/search/button:
                the GET form into the landed /search page. The kbd hint's
                data-global-init rides the official bundle (shortcut.ts:123
                registers onGlobalShortcut — focus-on-S, click-to-focus,
                aria-keyshortcuts are all bundle-side runtime behavior). */}
            <form class="ignore-dirty tw-flex" action={`${repoLink}/search`} method="get">
              <div class="ui small action input tw-flex tw-flex-1">
                <div class="ui input tw-flex tw-flex-1 global-shortcut-wrapper">
                  <input name="q" size={10} placeholder={searchPageLocale.code_kind} />
                  <kbd data-global-init="onGlobalShortcut" data-shortcut-keys="s">S</kbd>
                </div>
                <button type="submit" class="ui small icon button" aria-label={searchPageLocale.search}>
                  <Icon name="octicon-search" />
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
