/**
 * Repository wiki service — the remaining-API inventory's batch 10
 * (`wave-api-wiki`, specs/wiki.md): the six `/repos/{owner}/{repo}/wiki`
 * operations over a sibling ENGINE CELL, table-free.
 *
 * Storage convention (specs/wiki.md §3): upstream keeps the wiki as a REAL
 * sibling git repo `{repo}.wiki.git` (gitea/services/wiki/wiki.go — InitWiki,
 * the `repo.Name+".wiki"` push target). Ours is the parallel engine cell
 * `ownerNamespace/slug.wiki` (the landed combined-name addressing of
 * src/repos/service.ts engineName + src/api/services/engine.ts
 * engineRepoName, with upstream's `.wiki` suffix). The name is collision-free
 * by construction: `RESERVED_REPO_NAME_SUFFIXES` forbids `*.wiki` D1 repo
 * names, so no real repo cell can take the name. Provisioning is lazy — the
 * DO comes into existence on its first RPC and the wiki "exists" once its
 * default-branch ref exists; the first page write lands a ROOT commit
 * (upstream `hasDefaultBranch == false` commits without parents) through
 * putApiObjects + commitApiChange with the ZERO_OID create-on-empty CAS base
 * (the engine seats HEAD on the first branch itself). Empty-wiki reads are
 * not errors: pages list → empty, page/revisions/delete → not-found.
 * No engine-registry row: the registry feeds the public index and the git
 * gate's fetch authorization — a `.wiki` row would leak wiki cells into the
 * site index while the gate still 404s `*.wiki` git URLs (gate.ts §4.4);
 * reads/writes ride direct cell RPCs which need no registration.
 *
 * Name codec (specs/wiki.md §4): an exact port of
 * gitea/services/wiki/wiki_path.go — WebPath (route form) ↔ GitPath
 * (`….md` blob name) ↔ display title, with the `.-` dash-marker escape,
 * Go QueryEscape/QueryUnescape parity (space↔`+`, `!'()*` escaped —
 * unlike encodeURIComponent) and `util.PathJoinRelX`. One defensive
 * divergence: a git blob name with a MALFORMED percent escape never 500s the
 * pages list (upstream `GitPathToWebPath` error → APIErrorInternal,
 * routers/api/v1/repo/wiki.go ListWikiPages) — the codec keeps the original
 * segment instead, a name shape no wiki write can ever produce.
 *
 * Writes (specs/wiki.md §2): upstream `updateWikiPage` (wiki.go) semantics —
 * create requires absence (400 `ErrWikiAlreadyExist`), edit is a
 * remove-old-if-any + write-new (a missing page UPSERTS; a rename onto an
 * existing page replaces it), delete requires presence. The commit-message
 * templates are upstream's exact formats: create `Add %q(title)` /
 * edit `Update %q(newWikiName)` (router defaults) / delete
 * `Delete page %q(wikiName)` (service-side). Commit identity: author ==
 * committer == the doer (upstream `CommitTree(ctx, doer.NewGitSig(),
 * doer.NewGitSig(), …)`); timestamps are now — pinnable at write time via
 * `WikiWriteOptions.now` (the render-wallclock audit's fixed-time seam: the
 * stamps land in STORED git objects, so no render-site fixture can pin the
 * view's last-edited bytes; only the write path can).
 *
 * The landed contents-write orchestrator (`api/services/contents.ts
 * applyFileChanges`) is NOT reusable here — it addresses the REPO cell, hard
 * -404s an unborn branch, and runs the write grant itself — so the
 * equivalent reduction lives in this file against the same imported
 * primitives: `buildFileChangeCommit`/`buildBlobObject` (git-models),
 * `serializeCommit`/`serializeTree` (engine serializers) for the unborn root
 * commit, and `engineCell.putApiObjects` + `commitApiChange` CAS for the
 * landing (the git-http receive path is untouched; serialization across
 * concurrent API writes is the cell's own CAS).
 */

import {
  serializeCommit,
  serializeTree,
  type ApiObject,
  type CommitJson,
  type Person,
  type RepoCell,
} from "@cf-gitea/git-engine";

import type { ApiEnv } from "../api/env";
import { ApiError } from "../api/errors";
import {
  branchRef,
  commitApiChangeError,
  engineCell,
  engineReads,
  refTipMap,
  ZERO_OID,
  type EngineReads,
  type RefTip,
} from "../api/services/engine";
import { buildBlobObject, buildFileChangeCommit, type FileChange } from "../api/services/git-models";
import { lastCommitForPath } from "../api/services/contents";
import type { RepositoryWithOwner } from "../api/services/repository";

// ---------------------------------------------------------------------------
// Go stdlib parity (url.QueryEscape / url.QueryUnescape / url.PathUnescape /
// path.Clean / util.PathJoinRelX) — the codec's exact building blocks.
// ---------------------------------------------------------------------------

/** Go url.QueryEscape: space → `+`; Go escapes `!'()*` (JS does not). */
function queryEscape(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");
}

/** Go url.QueryUnescape (`+` → space); null on a malformed escape. */
function queryUnescape(text: string): string | null {
  try {
    return decodeURIComponent(text.replaceAll("+", "%20"));
  } catch {
    return null;
  }
}

/** Go url.PathUnescape (`+` stays a plus); null on a malformed escape. */
function pathUnescape(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Go path.Clean (POSIX). */
function pathClean(pathText: string): string {
  if (pathText === "") return ".";
  const rooted = pathText.startsWith("/");
  const out: string[] = [];
  for (const part of pathText.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!rooted) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return rooted ? `/${joined}` : joined === "" ? "." : joined;
}

/**
 * Port of upstream `util.PathJoinRelX` (modules/util/path.go): backslashes
 * become slashes, each element is `Clean("/" + e)`, elements join and clean,
 * the leading `/` strips (`/` → `.`). Empty-input arm: with NO non-empty
 * element the join is Go's `path.Join()` of nothing → `""` (PathJoinRel's
 * `case "": return ""`), so `pathJoinRelX("")` is `""`; only an all-dots
 * join cleans to `/` and answers `.`.
 */
export function pathJoinRelX(...elements: string[]): string {
  const cleaned: string[] = [];
  for (const element of elements) {
    if (element === "") continue;
    cleaned.push(pathClean(`/${element.replaceAll("\\", "/")}`));
  }
  if (cleaned.length === 0) return "";
  const joined = pathClean(cleaned.filter((part) => part !== "").join("/"));
  if (joined === "") return "";
  if (joined === "/") return ".";
  return joined.startsWith("/") ? joined.slice(1) : joined;
}

// ---------------------------------------------------------------------------
// The wiki WebPath codec (services/wiki/wiki_path.go, exact port)
// ---------------------------------------------------------------------------

/** Upstream `reservedWikiNames`. */
const RESERVED_WIKI_NAMES = new Set(["_pages", "_new", "_edit", "raw"]);

function hasDashMarker(segment: string): boolean {
  return segment.endsWith(".-");
}

function unescapeSegment(segment: string): string {
  const unmarked = hasDashMarker(segment) ? segment.slice(0, -2) : segment.replaceAll("-", " ");
  // a failed unescape keeps the original (upstream's ignored-error arm)
  return queryUnescape(unmarked) ?? unmarked;
}

function escapeSegmentToWeb(text: string, hadDashMarker: boolean): string {
  const marked =
    hadDashMarker || text.includes("-") || text.endsWith(".md") ? `${text}.-` : text.replaceAll(" ", "-");
  return queryEscape(marked);
}

/** Upstream `WebPathSegments` — the display segment per path level. */
export function webPathSegments(webPath: string): string[] {
  return webPath.split("/").map((segment) => unescapeSegment(segment));
}

/**
 * Upstream `validateWebPath` — returns the reserved segment, or null when
 * usable (the service maps it to the 400 `ErrWikiReservedName` text).
 */
export function validateWebPath(webPath: string): string | null {
  for (const segment of webPathSegments(webPath)) {
    if (RESERVED_WIKI_NAMES.has(segment)) return segment;
  }
  return null;
}

/** Upstream `WebPathToGitPath` — `.md`-suffixed WebPaths pass through raw. */
export function webPathToGitPath(webPath: string): string {
  if (webPath.endsWith(".md")) {
    return pathJoinRelX(pathUnescape(webPath) ?? webPath);
  }
  const segments = webPath.split("/").map((segment) => {
    const hadDashMarker = hasDashMarker(segment);
    const escaped = escapeSegmentToWeb(unescapeSegment(segment), hadDashMarker);
    // space is safe to keep in the git path (upstream's %20/+ restores)
    return escaped.replaceAll("%20", " ").replaceAll("+", " ");
  });
  return `${segments.join("/")}.md`;
}

/** Upstream `GitPathToWebPath` — null for a non-`.md` name (list skip). */
export function gitPathToWebPath(gitPath: string): string | null {
  if (!gitPath.endsWith(".md")) return null;
  const segments = gitPath
    .slice(0, -3)
    .split("/")
    .map((segment) => escapeSegmentToWeb(unescapeSegment(segment), hasDashMarker(segment)));
  return segments.join("/");
}

/** Upstream `WebPathFromRequest` — clean, then the legacy `/`→`%2F` form. */
export function webPathFromRequest(raw: string): string {
  return pathJoinRelX(raw).replaceAll("/", "%2F");
}

/** Upstream `UserTitleToWebPath` — TrimSpace, escape, clean, `unnamed` fallback. */
export function userTitleToWebPath(base: string, title: string): string {
  const joined = pathJoinRelX(base, escapeSegmentToWeb(title.trim(), false));
  return joined === "" || joined === "." ? "unnamed" : joined;
}

/** Upstream `WebPathToUserTitle` — the display title (+ dir) of a WebPath. */
export function webPathToUserTitle(webPath: string): { dir: string; display: string } {
  const at = webPath.lastIndexOf("/");
  const dir = at < 0 ? "." : webPath.slice(0, at);
  let display = at < 0 ? webPath : webPath.slice(at + 1);
  if (display.endsWith(".md")) {
    const bare = display.slice(0, -3);
    display = pathUnescape(bare) ?? bare;
  }
  return { dir, display: unescapeSegment(display) };
}

/** Go `%q` for the commit-message templates (printable unicode passes through). */
export function goQuote(text: string): string {
  let out = '"';
  for (const ch of text) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " ") out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

// ---------------------------------------------------------------------------
// Wire shapes (modules/structs/repo_wiki.go + services/convert/wiki.go —
// note upstream's `commiter` typo and the RFC3339-seconds dates)
// ---------------------------------------------------------------------------

export interface WikiCommitJson {
  sha: string;
  author: { name: string; email: string; date: string };
  /** upstream's one-t spelling, kept verbatim */
  commiter: { name: string; email: string; date: string };
  message: string;
}

export interface WikiPageMetaDataJson {
  title: string;
  html_url: string;
  sub_url: string;
  last_commit: WikiCommitJson | null;
}

export interface WikiPageJson extends WikiPageMetaDataJson {
  content_base64: string;
  commit_count: number;
  sidebar: string;
  footer: string;
}

export interface WikiCommitListJson {
  commits: WikiCommitJson[];
  count: number;
}

/** `setting.API.DefaultMaxBlobSize` (modules/setting/api.go). */
export const WIKI_MAX_BLOB_SIZE = 10_485_760;

/** `setting.Git.CommitsRangeSize` — the revisions endpoint's page size. */
export const WIKI_REVISIONS_PAGE_SIZE = 50;

/** Go RFC3339 (UTC, seconds precision) of a git person timestamp. */
function rfc3339(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `convert.ToWikiCommit` (services/convert/wiki.go). */
export function toWikiCommit(commit: CommitJson): WikiCommitJson {
  return {
    sha: commit.oid,
    author: { name: commit.author.name, email: commit.author.email, date: rfc3339(commit.author.time) },
    commiter: {
      name: commit.committer.name,
      email: commit.committer.email,
      date: rfc3339(commit.committer.time),
    },
    message: commit.message,
  };
}

/** `wiki_service.ToWikiPageMetaData` — display title + repo-anchored URLs. */
export function toWikiPageMetaData(
  wikiName: string,
  lastCommit: CommitJson | null,
  pair: RepositoryWithOwner,
  origin: string,
): WikiPageMetaDataJson {
  const { display } = webPathToUserTitle(wikiName);
  const ownerEnc = encodeURIComponent(pair.repo.ownerNamespace);
  const slugEnc = encodeURIComponent(pair.repo.slug);
  return {
    title: display,
    html_url: `${origin}/${ownerEnc}/${slugEnc}/wiki/${wikiName}`,
    sub_url: wikiName,
    last_commit: lastCommit === null ? null : toWikiCommit(lastCommit),
  };
}

// ---------------------------------------------------------------------------
// Cell addressing + shared read helpers
// ---------------------------------------------------------------------------

/** The sibling wiki cell's engine name parts: `owner/slug.wiki`. */
export function wikiCellName(pair: { ownerNamespace: string; slug: string }): {
  ownerNamespace: string;
  slug: string;
} {
  return { ownerNamespace: pair.ownerNamespace, slug: `${pair.slug}.wiki` };
}

/** The wiki cell's read client (null-on-failure posture, like engineReads). */
export function wikiReads(env: ApiEnv["Bindings"], pair: RepositoryWithOwner): EngineReads {
  return engineReads(env, wikiCellName(pair.repo));
}

/** The wiki cell's raw stub — write RPCs throw on transport failure. */
export function wikiCell(env: ApiEnv["Bindings"], pair: RepositoryWithOwner): DurableObjectStub<RepoCell> {
  return engineCell(env, wikiCellName(pair.repo));
}

/** The wiki's default branch = the repo's (specs/wiki.md §3). */
export function wikiBranch(pair: RepositoryWithOwner): string {
  return pair.repo.defaultBranch;
}

interface WikiTip {
  reads: EngineReads;
  tip: RefTip | undefined;
}

async function wikiTip(env: ApiEnv["Bindings"], pair: RepositoryWithOwner): Promise<WikiTip> {
  const reads = wikiReads(env, pair);
  const tips = refTipMap(await reads.listRefs());
  return { reads, tip: tips.get(branchRef(wikiBranch(pair))) };
}

/**
 * Upstream `prepareGitPath` (services/wiki/wiki.go): look for BOTH the
 * WebPath+`.md` (legacy raw-file form) and the coded GitPath; the found form
 * wins (it is the path removals must target). An unborn branch finds nothing.
 */
async function prepareWikiGitPath(
  reads: EngineReads,
  tip: string | undefined,
  wikiName: string,
): Promise<{ exists: boolean; foundPath: string; gitPath: string }> {
  const gitPath = webPathToGitPath(wikiName);
  if (tip === undefined) return { exists: false, foundPath: gitPath, gitPath };
  const unescaped = `${wikiName}.md`;
  if (unescaped !== gitPath) {
    const direct = await reads.readBlob(tip, unescaped);
    if (direct !== null) return { exists: true, foundPath: unescaped, gitPath };
  }
  const coded = await reads.readBlob(tip, gitPath);
  return { exists: coded !== null, foundPath: gitPath, gitPath };
}

/**
 * `findEntryForFile` (wiki.go router): the coded git path, then its
 * QueryUnescaped form. Returns the blob and the path that matched (the log
 * lookups must use the matched path).
 */
async function pageBlob(
  reads: EngineReads,
  tip: string,
  wikiName: string,
): Promise<{ data: Uint8Array; matchedPath: string } | null> {
  const gitPath = webPathToGitPath(wikiName);
  const coded = await reads.readBlob(tip, gitPath);
  if (coded !== null) return { data: coded.data, matchedPath: gitPath };
  const unescaped = pathUnescape(gitPath);
  if (unescaped !== null && unescaped !== gitPath) {
    const alt = await reads.readBlob(tip, unescaped);
    if (alt !== null) return { data: alt.data, matchedPath: unescaped };
  }
  return null;
}

/** `git.FileCommitsCount` — total commits touching the path (paged log walk). */
async function countCommitsForPath(reads: EngineReads, tip: string, gitPath: string): Promise<number> {
  let count = 0;
  let ofs = 0;
  // the engine's path-filtered walk scans at most 2000 commits
  // (PATH_LOG_SCAN, packages/git-engine src/repo.ts) — cap the count there.
  while (ofs <= 2000) {
    const page = await reads.listLog(tip, { path: gitPath, ofs, n: 100 });
    if (page === null || page.commits.length === 0) break;
    count += page.commits.length;
    if (!page.more) break;
    ofs += page.commits.length;
  }
  return count;
}

/** `_Sidebar` / `_Footer` — base64 or "" (absent or over the blob cap). */
async function sideContent(reads: EngineReads, tip: string, wikiName: string): Promise<string> {
  const found = await pageBlob(reads, tip, wikiName);
  if (found === null || found.data.byteLength > WIKI_MAX_BLOB_SIZE) return "";
  return base64Encode(found.data);
}

/** Base64 of bytes (git-models' chunked btoa — imported shape, local copy). */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export interface WikiPagesList {
  pages: WikiPageMetaDataJson[];
  /** ALL top-level entries (upstream totals count dirs too — the quirk). */
  totalEntries: number;
}

/**
 * `repoGetWikiPages` payload (wiki.go router ListWikiPages): TOP-LEVEL tree
 * entries only (not recursive — upstream limitation), paginated on the entry
 * INDEX with non-blob and non-`.md` entries silently skipped, totals over
 * every entry.
 */
export async function listWikiPages(
  env: ApiEnv["Bindings"],
  pair: RepositoryWithOwner,
  page: number,
  limit: number,
  origin: string,
): Promise<WikiPagesList> {
  const { reads, tip } = await wikiTip(env, pair);
  if (tip === undefined) return { pages: [], totalEntries: 0 };
  const tree = await reads.listTree(tip.target);
  if (tree === null) return { pages: [], totalEntries: 0 };
  const entries = tree.entries;
  const skip = (page - 1) * limit;
  const maxNum = page * limit;
  const pages: WikiPageMetaDataJson[] = [];
  for (const [index, entry] of entries.entries()) {
    if (index < skip || index >= maxNum || entry.type !== "blob") continue;
    const wikiName = gitPathToWebPath(entry.name);
    if (wikiName === null) continue;
    const lastCommit = await lastCommitForPath(reads, tip.target, entry.name);
    pages.push(toWikiPageMetaData(wikiName, lastCommit, pair, origin));
  }
  return { pages, totalEntries: entries.length };
}

/**
 * `repoGetWikiPage` payload (getWikiPage + wikiContentsByName): null when the
 * page (or the wiki branch) does not exist — the route's 404.
 */
export async function readWikiPage(
  env: ApiEnv["Bindings"],
  pair: RepositoryWithOwner,
  wikiName: string,
  origin: string,
): Promise<WikiPageJson | null> {
  const { reads, tip } = await wikiTip(env, pair);
  if (tip === undefined) return null;
  const found = await pageBlob(reads, tip.target, wikiName);
  if (found === null) return null;
  const content = found.data.byteLength > WIKI_MAX_BLOB_SIZE ? "" : base64Encode(found.data);
  const [sidebar, footer, commitCount, lastCommit] = await Promise.all([
    sideContent(reads, tip.target, "_Sidebar"),
    sideContent(reads, tip.target, "_Footer"),
    countCommitsForPath(reads, tip.target, found.matchedPath),
    lastCommitForPath(reads, tip.target, found.matchedPath),
  ]);
  return {
    ...toWikiPageMetaData(wikiName, lastCommit, pair, origin),
    content_base64: content,
    commit_count: commitCount,
    sidebar,
    footer,
  };
}

/**
 * `repoGetWikiPageRevisions` payload (ListPageRevisions): paged log at
 * CommitsRangeSize with `count` = the page's total commit count; null when
 * the page does not exist (route 404).
 */
export async function listWikiPageRevisions(
  env: ApiEnv["Bindings"],
  pair: RepositoryWithOwner,
  wikiName: string,
  page: number,
): Promise<WikiCommitListJson | null> {
  const { reads, tip } = await wikiTip(env, pair);
  if (tip === undefined) return null;
  const found = await pageBlob(reads, tip.target, wikiName);
  if (found === null) return null;
  const count = await countCommitsForPath(reads, tip.target, found.matchedPath);
  const log = await reads.listLog(tip.target, {
    path: found.matchedPath,
    ofs: (page - 1) * WIKI_REVISIONS_PAGE_SIZE,
    n: WIKI_REVISIONS_PAGE_SIZE + 1,
  });
  const commits = (log?.commits ?? []).slice(0, WIKI_REVISIONS_PAGE_SIZE).map(toWikiCommit);
  return { commits, count };
}

// ---------------------------------------------------------------------------
// The web raw arm (routers/web/repo/wiki.go WikiRaw — the family's byte route)
// ---------------------------------------------------------------------------

/** One raw wiki blob: `oid` is the ETag's bytes, `data` the full body. */
export interface WikiRawBlob {
  oid: string;
  data: Uint8Array;
}

/**
 * `WikiRaw` payload (wiki.go:597-639): the default-branch tip
 * (findWikiRepoCommit — an unborn wiki branch is its not-exist → NotFound
 * class, wiki.go:600-604), then the four `findEntryForFile` candidates in
 * upstream's probe order (wiki.go:609-628 over wiki.go:81-96): the coded git
 * path, its QueryUnescaped form, the `.md`-trimmed path (the non-`.md` raw
 * file round — the "image for example" arm), its QueryUnescaped form.
 * `rawTail` is the route's wildcard tail in the family's decoded convention
 * (`webPathFromRequest` re-encodes it). Null = the 404 family: no wiki
 * branch, or no entry after every candidate.
 */
export async function readWikiRawBlob(
  env: ApiEnv["Bindings"],
  pair: RepositoryWithOwner,
  rawTail: string,
): Promise<WikiRawBlob | null> {
  const { reads, tip } = await wikiTip(env, pair);
  if (tip === undefined) return null;
  const gitPath = webPathToGitPath(webPathFromRequest(rawTail));
  // TrimSuffix(providedGitPath, ".md") (wiki.go:622) — WebPathToGitPath
  // always yields a `.md` path, so the trim always fires.
  const trimmed = gitPath.endsWith(".md") ? gitPath.slice(0, -3) : gitPath;
  for (const target of [gitPath, trimmed]) {
    // findEntryForFile (wiki.go:81-96): the target, then Go
    // url.QueryUnescape(target) ("the shortest alternative"); the engine's
    // null read is the not-exist class.
    const unescaped = queryUnescape(target);
    const candidates = unescaped !== null && unescaped !== target ? [target, unescaped] : [target];
    for (const candidate of candidates) {
      const blob = await reads.readBlob(tip.target, candidate);
      if (blob !== null) return { oid: blob.oid, data: blob.data };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write operations (upstream updateWikiPage / DeleteWikiPage semantics)
// ---------------------------------------------------------------------------

/** The pusher identity — the route derives it like the contents family. */
export interface WikiDoer {
  name: string;
  email: string;
}

/**
 * Fixed-time write seam (render-wallclock-audit follow-up 2, the (c) class):
 * `wikiPerson` stamps the commit's author/committer time into STORED git
 * objects, so no render-site fixture can pin a view's last-edited bytes —
 * the pin has to happen at write time. `now` is unix seconds; absent = the
 * wall clock (every existing caller is byte-identical). The test-only
 * consumer is ui/testing/seed-wiki.ts (the golden view page's writer).
 */
export interface WikiWriteOptions {
  /** author/committer unix-seconds stamp for the landed commit. */
  now?: number;
}

function wikiPerson(doer: WikiDoer, now?: number): Person {
  return { name: doer.name, email: doer.email, time: now ?? Math.floor(Date.now() / 1000), tz: "+0000" };
}

/**
 * Land one change set on the wiki cell. Born branch: the imported
 * `buildFileChangeCommit` over the wiki reads + putApiObjects/commitApiChange
 * CAS on the observed tip. Unborn branch: a root commit over an empty base
 * tree (upstream commits without parents until the default branch exists).
 */
async function applyWikiChanges(
  env: ApiEnv["Bindings"],
  pair: RepositoryWithOwner,
  changes: FileChange[],
  message: string,
  doer: WikiDoer,
  options?: WikiWriteOptions,
): Promise<string> {
  const { reads, tip } = await wikiTip(env, pair);
  const person = wikiPerson(doer, options?.now);
  const cell = wikiCell(env, pair);
  const ref = branchRef(wikiBranch(pair));

  let objects: ApiObject[];
  let commitOid: string;
  let expectedOld: string;

  if (tip === undefined) {
    const root = new Map<string, { mode: string; oid: string }>();
    objects = [];
    for (const change of changes) {
      if (change.fromPath !== undefined) root.delete(change.fromPath);
      if (change.operation === "delete") {
        root.delete(change.path);
        continue;
      }
      const blob = await buildBlobObject(change.content ?? new Uint8Array());
      objects.push(blob);
      root.set(change.path, { mode: "100644", oid: blob.oid });
    }
    const tree = serializeTree([...root.entries()].map(([name, entry]) => ({ name, mode: entry.mode, oid: entry.oid })));
    objects.push({ oid: tree.oid, type: tree.type, data: tree.data });
    const commit = serializeCommit({
      tree: tree.oid,
      parents: [],
      author: person,
      committer: person,
      message,
    });
    objects.push({ oid: commit.oid, type: commit.type, data: commit.data });
    commitOid = commit.oid;
    expectedOld = ZERO_OID;
  } else {
    const built = await buildFileChangeCommit(reads, tip.target, changes, {
      message,
      author: person,
      committer: person,
    });
    if (built === null) {
      throw new ApiError(404, `branch does not exist [name: ${wikiBranch(pair)}]`);
    }
    const failed = built.outcomes.find((outcome) => !outcome.ok);
    if (failed !== undefined) {
      const error = failed.error ?? "";
      if (error.includes("already exists")) {
        throw new ApiError(400, `wiki page already exists [title: ${changes[0]?.path ?? ""}]`);
      }
      if (error.includes("does not exist")) {
        throw new ApiError(404, error);
      }
      throw new ApiError(422, error);
    }
    objects = built.objects;
    commitOid = built.commitOid;
    expectedOld = tip.target;
  }

  const stored = await cell.putApiObjects(objects);
  if (stored.tag !== "ok") {
    throw new ApiError(422, stored.tag === "invalid" ? stored.reason : "change too large");
  }
  const landed = await cell.commitApiChange({ ref, expectedOldOid: expectedOld, newOid: commitOid });
  if (landed.tag !== "committed") {
    throw commitApiChangeError(landed);
  }
  return landed.newOid;
}

export interface CreateWikiPageInput {
  title: string;
  content: Uint8Array;
  /** empty → the upstream default `Add %q(title)` (the RAW trimmed title) */
  message: string;
}

/**
 * `repoCreateWikiPage` (NewWikiPage + AddWikiPage): validate, refuse existing
 * (either candidate path), land on the wiki cell, and answer with the fresh
 * page read back from the landed ref.
 */
export async function createWikiPage(
  env: ApiEnv["Bindings"],
  pair: RepositoryWithOwner,
  doer: WikiDoer,
  input: CreateWikiPageInput,
  origin: string,
  options?: WikiWriteOptions,
): Promise<WikiPageJson> {
  const wikiName = userTitleToWebPath("", input.title);
  const reserved = validateWebPath(wikiName);
  if (reserved !== null) {
    throw new ApiError(400, `wiki title is reserved: ${reserved}`);
  }
  const { reads, tip } = await wikiTip(env, pair);
  const existing = await prepareWikiGitPath(reads, tip?.target, wikiName);
  if (existing.exists) {
    throw new ApiError(400, `wiki page already exists [title: ${existing.gitPath}]`);
  }
  const message = input.message === "" ? `Add ${goQuote(input.title)}` : input.message;
  await applyWikiChanges(
    env,
    pair,
    [{ operation: "create", path: existing.gitPath, content: input.content }],
    message,
    doer,
    options,
  );
  const page = await readWikiPage(env, pair, wikiName, origin);
  if (page === null) {
    throw new ApiError(500, "wiki page vanished after create");
  }
  return page;
}

export interface EditWikiPageInput {
  /** content bytes for the new revision */
  content: Uint8Array;
  /** empty → the upstream default `Update %q(newWikiName)` (the WebPath) */
  message: string;
  /** empty keeps the old name (upstream's binding-optional title) */
  title: string;
}

/**
 * `repoEditWikiPage` (EditWikiPage + updateWikiPage isNew=false): optional
 * rename (old path removed when present — a missing page UPSERTS, upstream's
 * `isOldWikiExist` arm), content rewritten at the coded new path. A reserved
 * NEW name mirrors upstream's 500 class (APIErrorInternal) by throwing an
 * untyped error into the 500 handler.
 */
export async function editWikiPage(
  env: ApiEnv["Bindings"],
  pair: RepositoryWithOwner,
  doer: WikiDoer,
  oldWikiName: string,
  input: EditWikiPageInput,
  origin: string,
  options?: WikiWriteOptions,
): Promise<WikiPageJson> {
  const newWikiName = input.title.trim() === "" ? oldWikiName : userTitleToWebPath("", input.title);
  if (validateWebPath(newWikiName) !== null) {
    // upstream: updateWikiPage's validateWebPath error → APIErrorInternal
    throw new Error(`wiki title is reserved: ${newWikiName}`);
  }
  const { reads, tip } = await wikiTip(env, pair);
  const newGitPath = webPathToGitPath(newWikiName);
  const changes: FileChange[] = [];
  if (oldWikiName !== newWikiName) {
    // rename: the old path moves out only when it exists (upsert semantics —
    // upstream's `isOldWikiExist` arm); the new path upserts at its coded form
    const oldPrepared = await prepareWikiGitPath(reads, tip?.target, oldWikiName);
    if (oldPrepared.exists) {
      changes.push({ operation: "update", path: newGitPath, content: input.content, fromPath: oldPrepared.foundPath });
    } else {
      changes.push({ operation: "update", path: newGitPath, content: input.content });
    }
  } else {
    // in-place: "update" upserts (present → content replaced, absent →
    // created; upstream's remove-if-present is a no-op when absent)
    changes.push({ operation: "update", path: newGitPath, content: input.content });
  }
  const message = input.message === "" ? `Update ${goQuote(newWikiName)}` : input.message;
  await applyWikiChanges(env, pair, changes, message, doer, options);
  const page = await readWikiPage(env, pair, newWikiName, origin);
  if (page === null) {
    throw new ApiError(500, "wiki page vanished after edit");
  }
  return page;
}

/**
 * `repoDeleteWikiPage` (DeleteWikiPage service): the page must exist (either
 * candidate path) — the found path is what gets removed. The message
 * template is upstream's non-overridable `Delete page %q(wikiName)`.
 */
export async function deleteWikiPage(
  env: ApiEnv["Bindings"],
  pair: RepositoryWithOwner,
  doer: WikiDoer,
  wikiName: string,
  options?: WikiWriteOptions,
): Promise<void> {
  const { reads, tip } = await wikiTip(env, pair);
  const prepared = await prepareWikiGitPath(reads, tip?.target, wikiName);
  if (!prepared.exists) {
    throw new ApiError(404, "not found");
  }
  await applyWikiChanges(
    env,
    pair,
    [{ operation: "delete", path: prepared.foundPath }],
    `Delete page ${goQuote(wikiName)}`,
    doer,
    options,
  );
}

// ---------------------------------------------------------------------------
// Route-level helpers shared by the wiki routes
// ---------------------------------------------------------------------------

/**
 * `ctx.FormInt` (strconv.Atoi): absent or non-integer → 0. The pages list
 * applies `max(page,1)` and `limit<=1 → 30` WITHOUT the max-50 clamp (its own
 * skip/maxNum math, wiki.go router).
 */
export function formInt(url: URL, key: string): number {
  const raw = url.searchParams.get(key);
  if (raw === null || !/^-?\d+$/.test(raw)) return 0;
  return Number.parseInt(raw, 10);
}

/** `DefaultPagingNum` (modules/setting/api.go). */
export const WIKI_DEFAULT_PAGING_NUM = 30;
