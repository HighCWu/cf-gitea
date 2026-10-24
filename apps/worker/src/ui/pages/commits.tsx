/**
 * The commit log page (§2.1 commits row, §3.3): `listLog(ref, {path, ofs,
 * n})` with page size 50 (upstream `setting.Git.CommitsRangeSize`),
 * `?page=N → ofs=(N-1)*50` clamped per §4.11, `LogResult.more` driving the
 * Older link, and the commits_list.tmpl row shape (components/commit-list).
 *
 * Both URL shapes the parser claims render here: the bare
 * `/:owner/:repo/commits` (default branch, `?path=` filter) and the
 * ref-suffixed `/:owner/:repo/commits/{branch|tag|commit}/{ref}[/{path}]`
 * whose treePath doubles as the file history filter (§3.3).
 */

import type { CommitJson } from "@cf-gitea/git-engine";

import { BranchSelector } from "../components/branch-selector";
import { CommitList, commitsLocale } from "../components/commit-list";
import type { EngineClient } from "../engine";
import { resolveRefSuffix, splitRefSuffix } from "../index";
import type { RefType } from "../index";
import { parsePageNumber, pathEscapeSegments } from "../page-data";
import { BaseLayout } from "../shell";
import type { UiContext } from "../ui-context";
import { resolveHeadBranch } from "./home";
import type { ResolvedRefs } from "./home";

/** Upstream `setting.Git.CommitsRangeSize` (modules/setting/git.go:44). */
export const COMMITS_PAGE_SIZE = 50;

/** The commits page render inputs, loaded by loadCommitsData. */
export interface CommitsData {
  refs: ResolvedRefs;
  active: { refType: RefType; ref: string };
  /** The `?path=`/treePath history filter ("" = whole-branch log). */
  path: string;
  page: number;
  commits: CommitJson[];
  more: boolean;
}

export interface CommitsNotFound {
  notFound: true;
}

/** Load the log (§3.2 direct RPCs). `notFound` covers the §4.5 404 family:
 *  no branches, a non-exact ref prefix, or the URL's ref unresolvable
 *  against listRefs. */
export async function loadCommitsData(
  engine: EngineClient,
  repo: { defaultBranch: string },
  options: { refSuffix: string | null; page: string | null; path: string | null },
): Promise<CommitsData | CommitsNotFound> {
  const refs = resolveHeadBranch(await engine.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return { notFound: true }; // unborn repo

  let active: { refType: RefType; ref: string };
  let suffixPath = "";
  if (options.refSuffix === null) {
    active = { refType: "branch", ref: refs.headBranch };
  } else {
    const split = splitRefSuffix(options.refSuffix);
    if (split === null) return { notFound: true }; // non-exact prefix (§3.3)
    const resolved = resolveRefSuffix(split.refType, split.rest, {
      branches: refs.branches,
      tags: refs.tags,
      defaultBranch: repo.defaultBranch,
    });
    if (resolved === null) return { notFound: true }; // unresolvable ref
    active = { refType: resolved.refType, ref: resolved.ref };
    suffixPath = resolved.treePath;
  }

  const path = suffixPath !== "" ? suffixPath : (options.path ?? "");
  const page = parsePageNumber(options.page);
  const log = await engine.listLog(active.ref, {
    path: path === "" ? undefined : path,
    ofs: (page - 1) * COMMITS_PAGE_SIZE,
    n: COMMITS_PAGE_SIZE,
  });
  if (log === null) return { notFound: true }; // unresolvable ref (§3.3)
  return { refs, active, path, page, commits: log.commits, more: log.more };
}

/** The Older/Newer pagination (§3.3: `LogResult.more` drives the Older link;
 *  §4.11: page < 1 clamps to 1, `more === false` hides Older). Renders
 *  nothing on a single page — upstream paginate's `TotalPages > 1` rule. */
export function CommitsPagination(props: { basePath: string; path: string; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  const href = (page: number): string => {
    const params = new URLSearchParams();
    if (props.path !== "") params.set("path", props.path);
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return query === "" ? props.basePath : `${props.basePath}?${query}`;
  };
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">{commitsLocale.newer}</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">{commitsLocale.older}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The commit log page (§2.4.1 discriminator: `repository commits`). */
export function CommitsPage(props: { ctx: UiContext; data: CommitsData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("CommitsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const basePath =
    data.active.refType === "branch" && data.active.ref === data.refs.headBranch
      ? `${repoLink}/commits`
      : `${repoLink}/commits/${data.active.refType}/${pathEscapeSegments(data.active.ref)}`;
  return (
    <BaseLayout ctx={ctx} title={commitsLocale.commits} pageClass="repository commits" activeTab="commits">
      <div class="ui container">
        <div class="repo-button-row">
          <div class="repo-button-row-left">
            <BranchSelector
              repoLink={repoLink}
              family="commits"
              refs={data.refs}
              active={data.active}
              treePath={data.path}
            />
          </div>
        </div>
        <div class="ui top attached header flex-left-right">
          <div class="flex-text-block">{commitsLocale.commits}</div>
        </div>
        <CommitList repoLink={repoLink} commits={data.commits} />
        <CommitsPagination basePath={basePath} path={data.path} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}
