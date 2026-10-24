/**
 * The URL shapes the slice-1 pages emit (SPEC-0008 §2.1/§3.3). Centralized so
 * the upstream-shaped link contract has one owner beside the route parsers:
 *
 * - tree/file links: `/{owner}/{repo}/src/{branch|tag|commit}/{ref}/{path}`
 *   (§3.3 — branch-prefixed, the ref-suffix families the parser claims);
 * - history links: `/{owner}/{repo}/commits?path={path}` for the file view's
 *   History button (§3.3), and the same `/commits/{refType}/{ref}` family for
 *   the branch selector;
 * - raw links: the tier-1 API route
 *   `/api/v1/repos/{owner}/{repo}/raw/{path}?ref={ref}` (§3.3 — documented
 *   divergence from upstream's web-shaped `/raw/branch/…`, open question 3);
 * - commit links: `/{owner}/{repo}/commit/{oid}` — upstream-shaped URLs that
 *   land on the 404 shell this slice (§1.2, open question 1).
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

export function commitLink(repoLink: string, oid: string): string {
  return `${repoLink}/commit/${encodeURIComponent(oid)}`;
}

/** §3.3: raw links target the tier-1 API route; anonymous GET on a public
 *  repo is allowed and the route streams (SPEC-0004 §2.4). */
export function rawFileLink(repoLink: string, treePath: string, ref: string): string {
  return `/api/v1/repos${repoLink}/raw/${pathEscapeSegments(treePath)}?ref=${encodeURIComponent(ref)}`;
}

/** The commits page's `?path=` filter form (§3.3 file-view History link). */
export function commitsHistoryLink(repoLink: string, treePath: string): string {
  return `${repoLink}/commits?path=${encodeURIComponent(treePath)}`;
}
