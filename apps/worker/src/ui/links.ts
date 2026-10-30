/**
 * The URL shapes the slice-1 pages emit (SPEC-0008 §2.1/§3.3). Centralized so
 * the upstream-shaped link contract has one owner beside the route parsers:
 *
 * - tree/file links: `/{owner}/{repo}/src/{branch|tag|commit}/{ref}/{path}`
 *   (§3.3 — branch-prefixed, the ref-suffix families the parser claims);
 * - history links: `/{owner}/{repo}/commits?path={path}` for the file view's
 *   History button (§3.3), and the same `/commits/{refType}/{ref}` family for
 *   the branch selector;
 * - raw links: the upstream WEB shape
 *   `/{owner}/{repo}/raw/{branch|tag|commit}/{ref}/{path}` (view_file.go:169;
 *   the former tier-1 API `?ref=` divergence is retired — the web family
 *   landed and every pasted raw URL now serves);
 * - commit links: `/{owner}/{repo}/commit/{oid}` — upstream-shaped URLs that
 *   land on the 404 shell this slice (§1.2, open question 1);
 * - profile links: `/{username}` — upstream `HomeLink()`'s shape (wave 7's
 *   dead-link unlock: every rendered poster/owner name anchors here). The
 *   single-segment namespace serves the OWNER profile (routers/web/user/
 *   profile.go:37 OwnerProfile): org rows render the org home
 *   (pages/org-home.tsx), user rows the user profile (pages/user-profile.tsx).
 */

import { pathEscapeSegments } from "./page-data";
import type { RefType } from "./index";

export function treeLink(repoLink: string, refType: RefType, ref: string, treePath = ""): string {
  const base = `${repoLink}/src/${refType}/${pathEscapeSegments(ref)}`;
  return treePath === "" ? base : `${base}/${pathEscapeSegments(treePath)}`;
}

export function commitsLink(repoLink: string, refType: RefType, ref: string, treePath = ""): string {
  const base = `${repoLink}/commits/${refType}/${pathEscapeSegments(ref)}`;
  return treePath === "" ? base : `${base}/${pathEscapeSegments(treePath)}`;
}

/**
 * The blame page link, `/{owner}/{repo}/blame/{refType}/{ref}/{path}`
 * (upstream view_file.tmpl:54's file-header button shape — RepoLink +
 * `/blame/` + RefTypeNameSubURL + PathEscapeSegments TreePath; web.go:1729-1733's
 * `/blame/{branch,tag,commit}/*` route family). Empty paths never link (the
 * blame page needs a file path — blame.go's TreePath=="" NotFound arm).
 */
export function blameLink(repoLink: string, refType: RefType, ref: string, treePath: string): string {
  return `${repoLink}/blame/${refType}/${pathEscapeSegments(ref)}/${pathEscapeSegments(treePath)}`;
}

export function commitLink(repoLink: string, oid: string): string {
  return `${repoLink}/commit/${encodeURIComponent(oid)}`;
}

/**
 * The raw file link — upstream view_file.go:169's WEB shape: RepoLink +
 * `/raw/` + RefTypeNameSubURL (`branch|tag|commit/{ref}`) + PathEscapeSegments
 * TreePath (web.go:1707-1713's group; the survey's PARTIAL row this wave
 * closes — the former tier-1 API link `?ref=` shape is retired, the
 * documented-divergence note above is history). The refType-less call form
 * (the repo-home README arm, where upstream's RawFileLink is "") falls to
 * the deprecated `/{ref}/{path}` catch-all (web.go:1712's RepoRefByType("")
 * arm) rather than the API route, so every pasted raw URL now lands on the
 * web family.
 */
export function rawFileLink(repoLink: string, treePath: string, ref: string, refType?: RefType): string {
  const prefix = refType === undefined ? "raw" : `raw/${refType}`;
  const base = `${repoLink}/${prefix}/${pathEscapeSegments(ref)}`;
  return treePath === "" ? base : `${base}/${pathEscapeSegments(treePath)}`;
}

/**
 * The media file link — view_file.go:210-212's RawFileLink overwrite for
 * LFS-pointed files: RepoLink + `/media/` + RefTypeNameSubURL
 * (`branch|tag|commit/{ref}`) + PathEscapeSegments TreePath (the identical
 * composition to rawFileLink under the SingleDownloadOrLFS group,
 * web.go:1707-1713 — /raw stays pointer bytes, the media family resolves
 * LFS). Callers gate on the file view's pointer probe (isLfsFile); regular
 * files keep rawFileLink. The refType-less form does not occur at the call
 * site (the file view always resolves the ref) but mirrors rawFileLink's
 * deprecated catch-all arm for symmetry.
 */
export function mediaFileLink(repoLink: string, treePath: string, ref: string, refType?: RefType): string {
  const prefix = refType === undefined ? "media" : `media/${refType}`;
  const base = `${repoLink}/${prefix}/${pathEscapeSegments(ref)}`;
  return treePath === "" ? base : `${base}/${pathEscapeSegments(treePath)}`;
}

/** The commits page's `?path=` filter form (§3.3 file-view History link). */
export function commitsHistoryLink(repoLink: string, treePath: string): string {
  return `${repoLink}/commits?path=${encodeURIComponent(treePath)}`;
}

/**
 * The owner profile link, `/{username}` (upstream `HomeLink()`) — user AND
 * org names share the single-segment namespace, so every name that renders
 * from a user row anchors through this one helper (wave 7: the profile page
 * is live, dead-link rule §2.4.1 no longer forces plain text).
 */
export function userLink(username: string): string {
  return `/${pathEscapeSegments(username)}`;
}
