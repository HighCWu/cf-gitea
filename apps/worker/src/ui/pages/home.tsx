/**
 * The repo browse page (§2.1 home row, §3.3 home wiring): repo header (the
 * shell's RepoHeader), the branch selector, the `#repo-files-table` root
 * listing with the latest-commit box and §3.5 per-entry enrichment, and the
 * README section rendered through the shared §3.4 markdown pipeline.
 *
 * Empty repos (§4.1: public, unborn HEAD) render the upstream repo/empty.tmpl
 * analog — clone command from the request origin + create-by-push hint, no
 * file list, no README — never a crash on `readCommit(null)`.
 */

import type { CommitJson, TreeEntryJson } from "@cf-gitea/git-engine";

import { BranchSelector, type SelectorRefs } from "../components/branch-selector";
import { FileContentView } from "../components/file-content";
import { RepoFilesTable } from "../components/file-list";
import type { EngineClient } from "../engine";
import { enrichTreeCommits, pickReadme, renderRepoMarkdown } from "../page-data";
import { BaseLayout } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";

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

/** The §4.1 empty-repo render (upstream repo/empty.tmpl analog): clone
 *  command from the request origin + create-by-push hint. */
export function EmptyRepoPage(props: { ctx: UiContext }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("EmptyRepoPage requires ctx.repo");
  const cloneUrl = `${ctx.origin}/${repo.ownerNamespace}/${repo.slug}.git`;
  return (
    <BaseLayout ctx={ctx} title="Quick Start" pageClass="repository quickstart" activeTab="code">
      <div class="ui container">
        <div class="ui segment">
          <h2 class="ui top header">
            This repository is empty. Push to create it (SPEC-0003 §2.5.2).
          </h2>
          <h3 class="ui top attached header">Create a new repository on the command line</h3>
          <div class="ui attached segment">
            <pre>{`touch README.md\ngit init\ngit add .\ngit commit -m "first commit"\ngit remote add origin ${cloneUrl}\ngit push -u origin ${repo.defaultBranch}`}</pre>
          </div>
          <h3 class="ui top attached header">Push an existing repository</h3>
          <div class="ui attached segment">
            <pre>{`git remote add origin ${cloneUrl}\ngit push -u origin ${repo.defaultBranch}`}</pre>
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
        <div class="repo-button-row">
          <div class="repo-button-row-left">
            <BranchSelector
              repoLink={repoLink}
              family="src"
              refs={data.refs}
              active={{ refType: "branch", ref: head }}
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
    </BaseLayout>
  );
}
