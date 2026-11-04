/**
 * The release-notes GENERATOR (census B-55's generate-notes tail, the form
 * behind web.go:1521's `POST /{owner}/{repo}/releases/generate-notes` —
 * `repo.GenerateReleaseNotes` at routers/web/repo/release.go:412-436 →
 * `release_service.GenerateReleaseNotes`, services/release/notes.go:30-70 at
 * the pin). The server-side template-generated release note: the merged-PR
 * digest the new/edit release form's "Generate release notes" button inserts
 * into the editor (web_src/js/features/repo-release.ts initGenerateReleaseNotes
 * — a urlencoded POST of tag_name/tag_target/previous_tag, the response's
 * `content` field appended to the textarea; the template data-generate-url
 * wiring at templates/repo/release/new.tmpl:59-66).
 *
 * The upstream service is a pure commit-walk over landed stores — no platform
 * force (the census row's rule-4/rule-5 verdict) — so this port keeps its
 * shape arm-for-arm:
 *
 *   1. resolveHeadCommit (notes.go:113-125): the TAG commit when the tag
 *      exists, else the tag_target ref; unresolved → the translatable
 *      `repo.release.generate_notes_target_not_found` error (handler 400).
 *   2. repoReleaseIsEmpty (notes.go:72-85): the non-draft, non-tag-only
 *      release count — the "first release" premise (IncludeDrafts false +
 *      IncludeTags false are FindReleasesOptions' defaults, release.go:267 /
 *      ToConds :275-282).
 *   3. the base commit (notes.go:41-50): previous_tag's commit, or — when no
 *      previous tag and NOT the first release — the SAME
 *      generate_notes_tag_not_found translatable error carrying the tag name
 *      (the "no previous tag given" arm), or "" for a first release (the
 *      full-history walk, notes.go:63-65's `rev-list after` shape).
 *   4. CommitsBetween (notes.go:52-54, modules/git/repo_commit.go:319-335's
 *      `rev-list base..head`): the engine's listCommitsRange; the empty-base
 *      first-release arm is the paged listLog walk (the unfiltered-walk cap
 *      convention — api/services/releases.ts countCommitsAt's MAX_LOG_SCAN
 *      bound; past it the walk pins, the honest-partial posture).
 *   5. collectPullRequestsFromCommits (notes.go:127-166):
 *      GetPullRequestByMergedCommit per commit (pull.go:1001-1023 —
 *      `base_repo_id AND merged_commit_id`), not-exist commits skipped;
 *      sorted MergedUnix desc, tie Issue.Index desc.
 *   6. collectContributors (notes.go:216-253): first-seen posters in PR order
 *      (@name lines); new contributors are posters with NO merged PR in the
 *      repo strictly BEFORE this PR's merged time excluding the PR itself
 *      (HasMergedPullRequestInRepoBefore, pull_list.go:370-388 — the joined
 *      issues+pull_request query, `merged_unix <` + `id !=`); PosterID 0
 *      (migrated PRs without a local user) skipped (notes.go:228-232).
 *   7. buildReleaseNotesContent (notes.go:168-215): "## What's Changed" +
 *      per-PR `* {title} in [#{index}]({html_url})` lines, the optional
 *      "## Contributors" / "## New Contributors" blocks, and the trailing
 *      "**Full Changelog**" line — the commits/tag link for a first release
 *      (notes.go:56-60's GitHub-aligned shape), else the
 *      `compare/{previous_tag}...{tag}` link.
 *
 * Deviations (documented): the commit-walk bound (5000, above); upstream's
 * `GetCommit` resolves ANY commitish for previous_tag (branches included) —
 * this port resolves through the same branch-then-tag-then-oid universe the
 * engine's ref tips carry (resolveNamedRef's order), the same answer for
 * every shape the form's dropdown emits (existing tag names). The response
 * envelope is the HANDLER's (ui/index.ts), not this module's.
 */

import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { branchRef, isFullObjectId, refTipMap, tagRef, type EngineReads } from "../../api/services/engine";
import { issues, pullRequests, releases, users } from "../../db/schema";
import { pathEscapeSegments } from "../page-data";
import type { RepoRow } from "../ui-context";

/** GenerateReleaseNotesOptions (notes.go:23-27). */
export interface ReleaseNotesOptions {
  tagName: string;
  tagTarget: string;
  previousTag: string;
}

export interface GenerateReleaseNotesInput {
  /** The landed read-side engine client (api/services/engine.ts). */
  reads: EngineReads;
  /** The metadata source of truth (D1). */
  d1: D1Database;
  /** The RepoAssignment row (the repo the notes describe). */
  repo: Pick<RepoRow, "id" | "ownerNamespace" | "slug" | "defaultBranch">;
  /** The request origin — repo.HTMLURL()'s prefix (AppURL + owner/repo). */
  origin: string;
  options: ReleaseNotesOptions;
}

/** The generator's outcomes — the `ok` arm is notes.go:69's content; the two
 *  not-found arms are notes.go:44-49's translatable errors (util.ErrNotExist
 *  wrapped, "repo.release.generate_notes_tag_not_found" /
 *  "..._target_not_found"), rendered by the handler as JSONError 400s. */
export type ReleaseNotesOutcome =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "tagNotFound"; readonly tag: string }
  | { readonly kind: "targetNotFound"; readonly ref: string };

/** The locale strings the outcomes render to (locale_en-US.json at the pin,
 *  TrString's raw shape — the handler emits them verbatim). */
export const releaseNotesLocale = {
  /** "repo.release.generate_notes_tag_not_found" */
  tagNotFound: (tag: string): string => `Tag "${tag}" does not exist in this repository.`,
  /** "repo.release.generate_notes_target_not_found" */
  targetNotFound: (ref: string): string => `The release target "${ref}" cannot be found.`,
} as const;

/** The per-PR record the content builder renders (the Issue-carrying PR,
 *  notes.go:169's signature reduced to the fields the Markdown reads). */
interface NotesPr {
  readonly prId: number;
  readonly index: number;
  readonly title: string;
  readonly mergedAt: Date | null;
  readonly posterId: number | null;
  readonly posterName: string | null;
}

/** The unfiltered-walk cap (releases.ts countCommitsAt's ENGINE_LOG_SCAN
 *  convention — the engine's own MAX_LOG_SCAN budget). */
const NOTES_WALK_BOUND = 5000;

const PAGE = 100;

/**
 * GenerateReleaseNotes (notes.go:30-70), arm order preserved. A null engine
 * read (transport/miss) lands in the same not-found arms the upstream
 * GetCommit errors do — the arm map above.
 */
export async function generateReleaseNotes(input: GenerateReleaseNotesInput): Promise<ReleaseNotesOutcome> {
  const { reads, d1, repo, origin, options } = input;
  const { tagName, tagTarget, previousTag } = options;

  // Arm 1 — resolveHeadCommit (notes.go:113-125): the tag tip first
  // (IsTagExist; an annotated tag peels to its commit — GetCommit's
  // CommitFromTag dereference), else the target ref (branch tips, then the
  // raw oid shape — GetCommit's rev-parse universe). The failing ref is the
  // one upstream names in the error.
  const tips = refTipMap(await reads.listRefs());
  const tagTip = tips.get(tagRef(tagName));
  const headRef = tagTip !== undefined ? (tagTip.peeled ?? tagTip.target) : tagTarget;
  const headCommit = await reads.readCommit(headRef);
  if (headCommit === null) {
    return { kind: "targetNotFound", ref: tagTip !== undefined ? tagName : tagTarget };
  }

  // Arm 2 — repoReleaseIsEmpty (notes.go:72-85): non-draft, non-tag rows
  // (FindReleasesOptions' IncludeDrafts/IncludeTags false defaults).
  const releaseCountRows = await drizzle(d1)
    .select({ n: sql<number>`count(*)` })
    .from(releases)
    .where(and(eq(releases.repoId, repo.id), eq(releases.isDraft, false), eq(releases.isTag, false)));
  const firstRelease = (releaseCountRows[0]?.n ?? 0) === 0;

  // Arm 3 — the base commit (notes.go:41-50). previous_tag resolves through
  // the same tips universe (GetCommit's commitish order: branch, tag, oid).
  let baseCommitId = "";
  if (previousTag !== "") {
    const prevTip = tips.get(branchRef(previousTag)) ?? tips.get(tagRef(previousTag));
    const prevRef = prevTip !== undefined ? (prevTip.peeled ?? prevTip.target) : previousTag;
    const prevCommit =
      prevTip !== undefined || isFullObjectId(previousTag) ? await reads.readCommit(prevRef) : null;
    if (prevCommit === null) {
      return { kind: "tagNotFound", tag: previousTag };
    }
    baseCommitId = prevCommit.oid;
  } else if (!firstRelease) {
    // notes.go:47-49 — no previous tag given on a non-first release: the
    // tag-not-found error carries the TAG name (the form's default guess
    // arm — the button's guessPreviousReleaseTag usually supplies a real
    // previous tag, this is the bare-POST fallback).
    return { kind: "tagNotFound", tag: tagName };
  }

  // Arm 4 — CommitsBetween (notes.go:52-54): `rev-list base..head`, or the
  // full-history walk for a first release (notes.go:65's bare `rev-list
  // after`). Order is irrelevant downstream (the PR sort reorders); the
  // walk is bounded (the module header's deviation note).
  const commitIds: string[] = [];
  if (baseCommitId !== "") {
    for (let page = 0; commitIds.length <= NOTES_WALK_BOUND; page++) {
      const result = await reads.listCommitsRange(baseCommitId, headCommit.oid, PAGE, page);
      if (result === null) break; // transport/miss → the collected prefix stands
      commitIds.push(...result.commits.map((commit) => commit.oid));
      if (!result.more) break;
    }
  } else {
    for (let ofs = 0; ofs <= NOTES_WALK_BOUND; ofs += PAGE) {
      const page = await reads.listLog(headCommit.oid, { ofs, n: PAGE });
      if (page === null) break; // transport failure → the collected prefix stands
      commitIds.push(...page.commits.map((commit) => commit.oid));
      if (!page.more) break;
    }
  }

  // Arm 5 — collectPullRequestsFromCommits (notes.go:127-166): the merged
  // PR per commit (GetPullRequestByMergedCommit's `base_repo_id AND
  // merged_commit_id`), not-exist commits skipped (notes.go:137-140).
  const prs: Omit<NotesPr, "posterName">[] = [];
  const posterIds = new Set<number>();
  for (const oid of commitIds) {
    const rows = await drizzle(d1)
      .select({
        prId: pullRequests.id,
        index: pullRequests.index,
        mergedAt: pullRequests.mergedAt,
        posterId: issues.posterId,
        title: issues.title,
      })
      .from(pullRequests)
      .innerJoin(issues, eq(pullRequests.issueId, issues.id))
      .where(and(eq(pullRequests.baseRepoId, repo.id), eq(pullRequests.mergedCommitId, oid)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) continue; // IsErrPullRequestNotExist → continue
    prs.push(row);
    if (row.posterId !== null && row.posterId > 0) posterIds.add(row.posterId);
  }

  // The sort (notes.go:144-151): MergedUnix desc, tie Issue.Index desc.
  prs.sort((a, b) => {
    const at = a.mergedAt?.getTime() ?? 0;
    const bt = b.mergedAt?.getTime() ?? 0;
    if (bt !== at) return bt - at;
    return b.index - a.index;
  });

  // The posters (LoadIssue/LoadAttributes' user fills — one batched read).
  const posters = new Map<number, string>();
  if (posterIds.size > 0) {
    const userRows = await drizzle(d1)
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...posterIds]));
    for (const row of userRows) posters.set(row.id, row.username);
  }
  const withPosters: NotesPr[] = prs.map((pr) => ({
    ...pr,
    posterName: pr.posterId !== null ? (posters.get(pr.posterId) ?? null) : null,
  }));

  // Arms 6-7 — the contributors' walk + the Markdown build.
  const { contributors, newContributors } = await collectContributors(d1, repo.id, withPosters);
  const htmlUrl = `${origin}/${repo.ownerNamespace}/${repo.slug}`;
  const content = buildReleaseNotesContent({
    repoHtmlUrl: htmlUrl,
    tagName,
    previousTag,
    prs: withPosters,
    contributors,
    newContributors,
    firstRelease,
  });
  return { kind: "ok", content };
}

/** One rendered contributor line's subject (the user's username). */
interface Contributor {
  readonly username: string;
}

/** A "first contribution" PR line's subject — the PR + its poster's name
 *  (notes.go:199-203's render inputs). */
interface NewContributor {
  readonly index: number;
  readonly posterName: string;
}

/**
 * collectContributors (notes.go:216-253): first-seen posters in PR order;
 * the first-contribution probe is HasMergedPullRequestInRepoBefore
 * (pull_list.go:370-388) per candidate. PosterID 0 rows skip (notes.go:228).
 */
async function collectContributors(
  d1: D1Database,
  repoId: string,
  prs: NotesPr[],
): Promise<{ contributors: Contributor[]; newContributors: NewContributor[] }> {
  const contributors: Contributor[] = [];
  const newContributors: NewContributor[] = [];
  const seenContributors = new Set<number>();
  const seenNew = new Set<number>();
  for (const pr of prs) {
    if (pr.posterId === null || pr.posterId === 0) continue; // notes.go:228-232
    if (pr.posterName === null) continue; // the vanished local user — no @name to render
    if (!seenContributors.has(pr.posterId)) {
      contributors.push({ username: pr.posterName });
      seenContributors.add(pr.posterId);
    }
    if (seenNew.has(pr.posterId)) continue;
    const isFirst = !(await hasMergedPullRequestInRepoBefore(d1, repoId, pr.posterId, pr.mergedAt, pr.prId));
    if (isFirst) {
      seenNew.add(pr.posterId);
      newContributors.push({ index: pr.index, posterName: pr.posterName });
    }
  }
  return { contributors, newContributors };
}

/**
 * HasMergedPullRequestInRepoBefore (pull_list.go:370-388) — the joined
 * issues+pull_request existence probe: `repo_id`, `poster_id`, `is_pull`,
 * `has_merged`, strictly `merged_unix <` the candidate's stamp (when set)
 * excluding the candidate PR row itself.
 */
async function hasMergedPullRequestInRepoBefore(
  d1: D1Database,
  repoId: string,
  posterId: number,
  before: Date | null,
  excludePullId: number,
): Promise<boolean> {
  const conditions = [
    eq(issues.repoId, repoId),
    eq(issues.posterId, posterId),
    eq(issues.isPull, true),
    eq(pullRequests.hasMerged, true),
  ];
  if (before !== null) conditions.push(lt(pullRequests.mergedAt, before));
  if (excludePullId > 0) conditions.push(ne(pullRequests.id, excludePullId));
  const rows = await drizzle(d1)
    .select({ id: issues.id })
    .from(issues)
    .innerJoin(pullRequests, eq(pullRequests.issueId, issues.id))
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

/**
 * buildReleaseNotesContent (notes.go:168-215) — the exact byte shape:
 * "## What's Changed" + the PR lines, blank line, the optional contributors
 * blocks, blank lines between blocks, and the trailing Full Changelog line
 * (the commits/tag URL for a first release, else the compare link labelled
 * `{previous}...{tag}`).
 */
function buildReleaseNotesContent(input: {
  repoHtmlUrl: string;
  tagName: string;
  previousTag: string;
  prs: NotesPr[];
  contributors: Contributor[];
  newContributors: NewContributor[];
  firstRelease: boolean;
}): string {
  const { repoHtmlUrl, tagName, previousTag, prs, contributors, newContributors, firstRelease } = input;
  let out = "## What's Changed\n";
  for (const pr of prs) {
    out += `* ${pr.title} in [#${pr.index}](${repoHtmlUrl}/pulls/${pr.index})\n`;
  }
  out += "\n";
  if (contributors.length > 0) {
    out += "## Contributors\n";
    for (const contributor of contributors) {
      out += `* @${contributor.username}\n`;
    }
    out += "\n";
  }
  if (newContributors.length > 0) {
    out += "## New Contributors\n";
    for (const contributor of newContributors) {
      out += `* @${contributor.posterName} made their first contribution in [#${contributor.index}](${repoHtmlUrl}/pulls/${contributor.index})\n`;
    }
    out += "\n";
  }
  out += "**Full Changelog**: ";
  if (firstRelease) {
    // notes.go:56-60 — the first-release changelog link stays GitHub-aligned
    // while the PR collection walks the FULL history.
    out += `${repoHtmlUrl}/commits/tag/${pathEscapeSegments(tagName)}`;
  } else {
    const compareUrl = `${repoHtmlUrl}/compare/${pathEscapeSegments(previousTag)}...${pathEscapeSegments(tagName)}`;
    out += `[${previousTag}...${tagName}](${compareUrl})`;
  }
  out += "\n";
  return out;
}
