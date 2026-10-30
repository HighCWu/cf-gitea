import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { releaseAssets, releases, users } from "../../db/schema";
import { ReleaseAlreadyExistError } from "../../issues/errors";
import { IssuesService, type ReleaseRow } from "../../issues/service";
import { isTagControlAllowed, listProtectedTags } from "../../services/tag-protection";
import { ApiError } from "../errors";
import type { ApiEnv } from "../env";
import type { Release } from "../models/release";
import type { User } from "../models/user";
import { engineReads, refTipMap, tagRef } from "./engine";
import { apiUserFromRow, type RepositoryWithOwner, type Viewer } from "./repository";
import { resolveTagTarget, writeTagRef, type TagCreator } from "./tags";

/**
 * Release reads/converters backing the tier-1 `repository`-tagged release
 * routes (SPEC-0004 §2.4 rows repoListReleases / repoCreateRelease /
 * repoGetLatestRelease / repoGetReleaseByTag / repoDeleteReleaseByTag /
 * repoGetRelease / repoEditRelease / repoDeleteRelease). Writes ride the
 * landed SPEC-0005 `IssuesService.createRelease` (409 semantics, tag-record
 * conversion); this module adds what the data layer deliberately does not
 * model: the filtered list/latest reads, the edit patch, the delete, and the
 * wire converter.
 *
 * Engine boundary (UPDATED by the findings-links N2 fix + its kept-open
 * tail, this change): the CREATE path also lands the GIT TAG for a fresh
 * `tag_name` through the shared tag-store service (services/tags.ts — the
 * tag-creation API's mechanism) and FILLS the row's `sha1`/`num_commits`/
 * `created_unix` from the tagged commit (upstream createTag's post-write
 * fill, release.go:148-158); the EDIT/DELETE paths remain D1-only (upstream's
 * UpdateRelease tag arm and DeleteReleaseByID's delTag stay open engine-wave
 * items — the publish-time fill rides that same open arm).
 *
 * Upstream citations (submodule pin fc4936884584):
 *  - list: `routers/api/v1/repo/release.go ListReleases` — FindReleases
 *    {IncludeDrafts: write access, IncludeTags: false, `draft`/`pre-release`
 *    optional-bool filters, `tag_filter` LIKE with `*` wildcards}, ordering
 *    `created_unix DESC, id DESC` (models/repo/release.go FindReleasesOptions
 *    ToOrders);
 *  - latest: `GetLatestReleaseByRepoID` (release.go:338–350) — not draft,
 *    not prerelease, not tag, newest created_unix (id tiebreak);
 *  - single: `GetReleaseForRepoByID` — the GLOBAL id scoped through this
 *    repo; tag-only records (`is_tag`) are 404 for every operation; drafts
 *    are 404 without release-write access (canAccessReleaseDraft);
 *  - edit: `EditRelease` — only set fields apply (empty string = untouched);
 *    the published stamp flips when a draft is published
 *    (services/release UpdateRelease → `!IsDraft && PublishedUnix == 0`);
 *  - delete: `DeleteReleaseByID` — the row plus its attachments;
 *  - converter: `services/convert/release.go ToAPIRelease` + the Release URL
 *    methods (models/repo/release.go:130–155) — APIURL
 *    `{repo APIURL}/releases/{id}`, HTMLURL `{repo HTMLURL}/releases/tag/
 *    {tag}`, TarURL/ZipURL `{repo HTMLURL}/archive/{tag}.tar.gz|zip`,
 *    UploadURL `{repo APIURL}/releases/{id}/assets`; `published_at` null for
 *    drafts; assets empty until the R2 asset wave.
 */

/** The release-write gate's data dependency set (canAccessReleaseDraft). */
export interface ReleaseAccess {
  /** Signed-in caller with release-write access sees drafts. */
  canWrite: boolean;
}

/** `IsDraft`/`IsPreRelease` optional-bool filter: null = unfiltered. */
export type ReleaseBoolFilter = boolean | null;

export interface ReleaseListOptions {
  includeDrafts: boolean;
  /** The `draft` query filter (null = unfiltered). */
  isDraft: ReleaseBoolFilter;
  /** The `pre-release` query filter (null = unfiltered). */
  isPrerelease: ReleaseBoolFilter;
  /** `tag_filter` with `*` wildcards ("" = unfiltered). */
  tagFilter: string;
  page: number;
  limit: number;
}

/**
 * The `tag_filter` glob, translated off LIKE. Upstream (models/repo/
 * release.go:302-309) lowercases the filter, escapes `\`/`_`/`%` literal,
 * turns `*` into `%`, and LIKEs `lower_tag_name` — only `*` is a wildcard.
 * The landed shape (`*` → `%` into a raw parameterized LIKE) kept the glob
 * but leaked `%`/`_` as wildcards AND hit D1's 50-byte LIKE pattern cap: a
 * long `tag_filter` threw D1_ERROR and the route answered a plain 500. The
 * translation keeps upstream's exact semantics on instr()/substr()
 * primitives — no pattern, no cap (the documented user-search precedent,
 * services/user.ts:81-97, the org-members 943e1e9 shape) — and `%`/`_`
 * land literal the way upstream's escaping made them.
 *
 * Exactness: S matches `s0*s1*…*sn` iff S starts with s0, ends with sn,
 * and the middles s1..s(n-1) embed in order without overlap. Greedy
 * leftmost is exact — taking each middle's first occurrence in the
 * remainder leaves the maximal tail, so the greedy embedding exists
 * whenever any embedding does. The suffix is pinned to S's very end and
 * must start past the consumed prefix+middles (glob embeddings never
 * overlap: `*` may match empty but segments occupy disjoint ranges), which
 * a plain endswith check would not enforce — the length inequality pins
 * it. All SQL primitives (instr/substr/length) are character-based, so
 * multi-byte tags translate consistently.
 *
 * Pragmatic bound (the only divergence from upstream): a filter with more
 * than 64 non-empty `*` segments would build a WHERE expression past
 * SQLite's expression-depth comfort (the chain nests per middle) — those
 * match nothing (`0 = 1`), matching no result rather than a D1_ERROR 500.
 * Upstream patterns (v1*, *beta, *rc*) use 0-2 stars.
 */
function tagFilterCondition(tagFilter: string): SQL {
  const subject = sql`lower(${releases.tagName})`;
  const segments = tagFilter.toLowerCase().split("*");
  if (segments.length === 1) {
    // No `*`: upstream's plain `%s%` substring.
    return sql`instr(${subject}, ${segments[0]}) > 0`;
  }
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  const middles = segments.slice(1, -1).filter((segment) => segment !== "");
  if (middles.length > 64) return sql`0 = 1`;
  const conds: SQL[] = [];
  let pinned = first !== "";
  if (first !== "") {
    conds.push(sql`instr(${subject}, ${first}) = 1`);
  }
  // The greedy chain: `searchFrom` is the 1-based position the next segment
  // must start at (one past everything already pinned).
  let searchFrom: SQL = first === "" ? sql`1` : sql`length(${first}) + 1`;
  for (const middle of middles) {
    const found = sql`instr(substr(${subject}, ${searchFrom}), ${middle})`;
    conds.push(sql`${found} > 0`);
    searchFrom = sql`${searchFrom} + ${found} + length(${middle}) - 1`;
    pinned = true;
  }
  if (last !== "") {
    conds.push(sql`substr(${subject}, -length(${last})) = ${last}`);
    if (pinned) {
      // The endswith must not overlap the pinned segments.
      conds.push(sql`length(${subject}) >= ${searchFrom} + length(${last}) - 1`);
    }
  }
  if (conds.length === 0) return sql`1 = 1`; // the bare `*` glob matches all
  return and(...conds) as SQL;
}

/**
 * `FindReleases` on the D1 releases table: tag-only rows excluded
 * (IncludeTags: false), drafts hidden unless the caller has write access or
 * explicitly filtered for them WITH access, `created_unix DESC, id DESC`.
 */
export async function listReleases(
  d1: D1Database,
  repoId: string,
  opts: ReleaseListOptions,
): Promise<{ items: ReleaseRow[]; total: number }> {
  const conditions: SQL[] = [eq(releases.repoId, repoId), eq(releases.isTag, false)];
  if (opts.isDraft === null) {
    if (!opts.includeDrafts) {
      conditions.push(eq(releases.isDraft, false));
    }
  } else if (opts.isDraft) {
    // Drafts filtered IN: without write access the filter matches nothing
    // (upstream: IncludeDrafts false + IsDraft true → empty result).
    if (opts.includeDrafts) {
      conditions.push(eq(releases.isDraft, true));
    } else {
      conditions.push(sql`0 = 1`);
    }
  } else {
    conditions.push(eq(releases.isDraft, false));
  }
  if (opts.isPrerelease !== null) {
    conditions.push(eq(releases.isPrerelease, opts.isPrerelease));
  }
  if (opts.tagFilter !== "") {
    conditions.push(tagFilterCondition(opts.tagFilter));
  }
  const where = and(...conditions);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(releases).where(where);
  const items = await db
    .select()
    .from(releases)
    .where(where)
    .orderBy(desc(releases.createdAt), desc(releases.id))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/** `GetLatestReleaseByRepoID` — the install-script contract (SPEC-0004 §2.4). */
export async function findLatestRelease(d1: D1Database, repoId: string): Promise<ReleaseRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(releases)
    .where(
      and(eq(releases.repoId, repoId), eq(releases.isDraft, false), eq(releases.isPrerelease, false), eq(releases.isTag, false)),
    )
    .orderBy(desc(releases.createdAt), desc(releases.id))
    .limit(1);
  return rows[0] ?? null;
}

/** `GetRelease(repoID, tag)` — case-insensitive tag lookup (lower_tag_name). */
export async function findReleaseByTag(d1: D1Database, repoId: string, tag: string): Promise<ReleaseRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(releases)
    .where(and(eq(releases.repoId, repoId), eq(releases.lowerTagName, tag.toLowerCase())))
    .limit(1);
  return rows[0] ?? null;
}

/** `GetReleaseForRepoByID` — the GLOBAL id scoped through this repo. */
export async function findReleaseForRepoById(d1: D1Database, repoId: string, id: number): Promise<ReleaseRow | null> {
  if (id <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(releases)
    .where(and(eq(releases.id, id), eq(releases.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The create path WITH the git tag (findings-links N2): upstream
// POST /repos/{owner}/{repo}/releases auto-creates the release's git tag —
// routers/api/v1/repo/release.go CreateRelease 259-287 → release_service
// .CreateRelease (services/release/release.go:173-199) → createTag
// (release.go:69-166) — from `target_commitish` (the default branch when
// absent). Without it every git-tag-shaped link for the release 404s.
// ---------------------------------------------------------------------------

export interface CreateReleaseWithGitTagInput {
  /** The worker bindings — the engine cell client's source. */
  env: ApiEnv["Bindings"];
  /** D1 — the releases row's store. */
  d1: D1Database;
  /** The repo: engine cell name + D1 scope + default branch. */
  pair: RepositoryWithOwner;
  publisherId: number;
  /** The authenticated creator — tagger identity + protected-tag subject. */
  doer: TagCreator | null | undefined;
  /** Request host, for the `<login>@noreply.<host>` tagger fallback. */
  requestHost: string;
  tagName: string;
  /** `target_commitish` — absent/"" resolves the default branch. */
  targetCommitish: string | undefined;
  /** Non-empty → the tag is created ANNOTATED (upstream TagMessage). */
  tagMessage: string | undefined;
  title: string;
  note: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

export interface CreateReleaseWithGitTagResult {
  /** The release row — for a published release, already carrying the
   *  upstream createTag fill (sha1/num_commits/created_unix = the tagged
   *  commit's); drafts return the bare writer row. */
  row: ReleaseRow;
  /** True when THIS call created the git tag (upstream createTag's `created`
   *  — drives the ref-webhook pair; an existing tag rides silently). */
  tagCreated: boolean;
  /** The new ref's tip — the TAG OBJECT oid when annotated — the create
   *  payload's `sha`. Defined only when tagCreated. */
  tagTip?: string;
}

/**
 * `git.CommitsCountOfCommit` (release.go:155 `CommitsCount`) — commits
 * reachable from the tagged commit. The engine has no count RPC; the answer
 * is the paged unfiltered listLog walk (the wiki countCommitsForPath
 * precedent, services/wiki.ts) capped at the engine's own unfiltered walk
 * budget (MAX_LOG_SCAN = 5000, packages/git-engine src/repo.ts) — past the
 * cap the count pins there, the same honest-partial posture as the commits
 * route's X-Total-Count approximation. A null page is a transport-class
 * failure on a commit known to exist → the upstream abort (below).
 */
async function countCommitsAt(reads: ReturnType<typeof engineReads>, tip: string): Promise<number> {
  const ENGINE_LOG_SCAN = 5000; // MAX_LOG_SCAN, packages/git-engine src/repo.ts:121
  let count = 0;
  let ofs = 0;
  while (ofs <= ENGINE_LOG_SCAN) {
    const page = await reads.listLog(tip, { ofs, n: 100 });
    if (page === null) {
      throw new Error(`CommitsCount: log walk unreadable [sha1: ${tip}]`);
    }
    count += page.commits.length;
    if (!page.more) break;
    ofs += page.commits.length;
  }
  return count;
}

/**
 * Create a release row AND its git tag, upstream's exact sequence:
 *
 *   1. duplicate release row → 409 BEFORE any git write (CreateRelease's
 *      IsReleaseExist, release.go:174-181; exact-tagName lookup, the
 *      IssuesService semantics — the unique index arbitrates the race);
 *   2. a tag-only record does NOT conflict (the §2.3 conversion path —
 *      upstream reaches it through UpdateRelease, whose createTag arm
 *      release.go:262 lands the tag before the row write, as below);
 *   3. published releases only (drafts defer the tag to their publish
 *      moment — createTag's `!rel.IsDraft` gate, release.go:78), ordered
 *      exactly like createTag: git tag exists → RIDE it, no duplicate
 *      (release.go:78 `IsTagExist`); protected tag → 422 "release tag name
 *      is protected [tag_name: …]" (release.go:87-102 + the handler's
 *      IsErrProtectedTagName answer, release.go:281-282); unresolvable
 *      target → 404 "target not found" with NO row created
 *      (release.go:104-113 GetCommit + the handler's git.IsErrNotExist
 *      answer, release.go:283-284); `tag_message` → annotated tag
 *      (release.go:110-121);
 *   4. the post-write fill (createTag release.go:148-158 — this change):
 *      for EVERY resolved tag (fresh-created, ridden existing, and the §2.3
 *      D1-only conversions alike — upstream's fill sits inside the
 *      `!IsDraft` block after the tag arm) the tagged commit is read
 *      (engineReads.readCommit — peels an annotated tag's object oid to its
 *      commit, GetTagCommit's dereference) and the row's `sha1` =
 *      commit oid, `num_commits` = reachable-commit count
 *      (CommitsCountOfCommit), `created_unix` = the COMMIT's committer time
 *      — "dated by its commit, so an old commit does not become the latest
 *      release" (release.go:154). The reads run BEFORE the row write, in
 *      upstream's order (createTag fills, THEN CreateRelease inserts,
 *      release.go:183-189): a failed fill aborts with no row, exactly
 *      upstream's GetTagCommit/CommitsCount error path. The write itself is
 *      the one residual of the shared-writer boundary (IssuesService owns
 *      the INSERT): the precomputed fill lands as an UPDATE returning the
 *      row, so the caller's row already carries it (the route renders
 *      toApiRelease + the release webhook from it — `created_at` becomes
 *      the commit time, upstream ToAPIRelease's `CreatedAt:
 *      r.CreatedUnix.AsTime()`).
 *   5. the row write rides the landed SPEC-0005 writer
 *      (IssuesService.createRelease — the 409 race fallback + the
 *      tag-record conversion, unchanged).
 *
 * Draft posture (release.go:166-168's else arm): NO tag, NO fill —
 * `created_unix` stays the row time, `sha1` null, `num_commits` 0. The
 * publish-time fill is upstream's UpdateRelease → createTag re-run
 * (release.go:269 — every edit re-runs createTag, whose fill then applies);
 * that arm belongs to the still-open UpdateRelease tag wave and is NOT
 * filled here (filling a commit a D1-only publish never tagged would point
 * sha1 at a ref that does not exist).
 *
 * NOT replicated: createTag's MustNotBeArchived arm (release.go:74-77) —
 * upstream's release handler maps none of its outcomes (an archived-repo
 * release create dies as an internal 500 there), and the landed release
 * surface deliberately registers no mustNotBeArchived (the pinned 201 on
 * archived repos); the tag is created.
 */
export async function createReleaseWithGitTag(input: CreateReleaseWithGitTagInput): Promise<CreateReleaseWithGitTagResult> {
  const { pair } = input;
  const repoId = pair.repo.id;

  const existing = await drizzle(input.d1)
    .select()
    .from(releases)
    .where(and(eq(releases.repoId, repoId), eq(releases.tagName, input.tagName)))
    .get();
  if (existing !== undefined && !existing.isTag) {
    throw new ReleaseAlreadyExistError(input.tagName);
  }

  let tagCreated = false;
  let tagTip: string | undefined;
  // The tagged COMMIT's oid — the fill's read target. Undefined = draft (no
  // tag, no fill).
  let taggedCommitSha: string | undefined;
  if (!input.isDraft) {
    const tips = refTipMap(await engineReads(input.env, pair.repo).listRefs());
    const existingTip = tips.get(tagRef(input.tagName));
    if (existingTip === undefined) {
      if (!(await isTagControlAllowed(input.d1, await listProtectedTags(input.d1, repoId), input.tagName, input.doer?.id ?? 0))) {
        throw new ApiError(422, `release tag name is protected [tag_name: ${input.tagName}]`);
      }
      const resolved = await resolveTagTarget(input.env, pair.repo, input.targetCommitish);
      if (resolved.tag === "not-found") {
        throw new ApiError(404, "target not found");
      }
      const written = await writeTagRef(input.env, pair.repo, {
        name: input.tagName,
        commitSha: resolved.commitSha,
        message: input.tagMessage,
        doer: input.doer,
        requestHost: input.requestHost,
      });
      if (written.tag === "invalid") {
        throw new ApiError(422, written.reason);
      }
      if (written.tag === "conflict") {
        throw written.error;
      }
      tagCreated = true;
      tagTip = written.refTip;
      taggedCommitSha = written.commitSha; // already the peeled commit (resolveTagTarget)
    } else {
      // The ride arm: the ref's tip peeled to its commit — an annotated tag
      // carries the engine's peel cache (`peeled`), a lightweight tag's
      // target IS the commit (GetTagCommit's dereference, release.go:148).
      taggedCommitSha = existingTip.peeled ?? existingTip.target;
    }
  }

  // The pre-write fill reads, upstream's order (createTag's fill precedes
  // CreateRelease's insert — release.go:148-158 then :189): a read failure
  // aborts with NO row, exactly the upstream GetTagCommit/CommitsCount 500.
  let fill: { sha1: string; numCommits: number; createdAt: Date } | undefined;
  if (taggedCommitSha !== undefined) {
    const reads = engineReads(input.env, pair.repo);
    const commit = await reads.readCommit(taggedCommitSha);
    if (commit === null) {
      throw new Error(`GetTagCommit: the tagged commit is unreadable [sha1: ${taggedCommitSha}]`);
    }
    fill = {
      sha1: commit.oid,
      numCommits: await countCommitsAt(reads, commit.oid),
      createdAt: new Date(commit.committer.time * 1000), // release.go:154: dated by its commit
    };
  }

  const target =
    input.targetCommitish !== undefined && input.targetCommitish !== "" ? input.targetCommitish : pair.repo.defaultBranch;
  const row = await new IssuesService(input.d1).createRelease({
    repoId,
    publisherId: input.publisherId,
    tagName: input.tagName,
    target,
    title: input.title,
    note: input.note,
    isDraft: input.isDraft,
    isPrerelease: input.isPrerelease,
  });

  if (fill === undefined) {
    return { row, tagCreated, tagTip };
  }
  // The fill write (the shared-writer residual — see step 4 above): the
  // returned row already carries sha1/num_commits/created_unix for the
  // route's render + release webhook.
  const filled = await drizzle(input.d1)
    .update(releases)
    .set({ sha1: fill.sha1, numCommits: fill.numCommits, createdAt: fill.createdAt })
    .where(eq(releases.id, row.id))
    .returning();
  return { row: filled[0] ?? row, tagCreated, tagTip };
}

export interface EditReleasePatch {
  /** Non-empty strings replace (upstream `len(form.X) > 0` guards). */
  tagName?: string;
  target?: string;
  title?: string;
  note?: string;
  /** Explicit tri-flags (undefined = untouched). */
  isDraft?: boolean;
  isPrerelease?: boolean;
  now: Date;
}

/**
 * `EditRelease` — apply the set fields; publishing a draft (draft → false)
 * stamps `published_unix` when it was unpublished (UpdateRelease rule).
 * Returns null only when the optimistic rename lost a concurrent write.
 */
export async function editRelease(d1: D1Database, row: ReleaseRow, patch: EditReleasePatch): Promise<ReleaseRow | null> {
  const isDraft = patch.isDraft ?? row.isDraft;
  const wasDraft = row.isDraft;
  const publishedUnix =
    wasDraft && !isDraft && row.publishedUnix === 0 ? Math.floor(patch.now.getTime() / 1000) : row.publishedUnix;
  const rows = await drizzle(d1)
    .update(releases)
    .set({
      tagName: patch.tagName ?? row.tagName,
      lowerTagName: (patch.tagName ?? row.tagName).toLowerCase(),
      target: patch.target ?? row.target,
      title: patch.title ?? row.title,
      note: patch.note ?? row.note,
      isDraft,
      isPrerelease: patch.isPrerelease ?? row.isPrerelease,
      publishedUnix,
    })
    .where(eq(releases.id, row.id))
    .returning();
  return rows[0] ?? null;
}

/**
 * `DeleteReleaseByID` — the release row and its asset rows in one batch (the
 * R2 blobs follow the asset wave; the D1 cascade is complete).
 */
export async function deleteRelease(d1: D1Database, row: ReleaseRow): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).delete(releaseAssets).where(eq(releaseAssets.releaseId, row.id)),
    drizzle(d1).delete(releases).where(eq(releases.id, row.id)),
  ]);
}

/** Drafts are invisible without release-write access (the release family's
 *  recurring 404). */
export function assertDraftVisible(access: ReleaseAccess, row: ReleaseRow): void {
  if (row.isDraft && !access.canWrite) {
    throw new ApiError(404, "not found");
  }
}

/** Tag-only records are 404 for every release operation (upstream IsTag). */
export function assertNotTagRecord(row: ReleaseRow): void {
  if (row.isTag) {
    throw new ApiError(404, "not found");
  }
}

// ---------------------------------------------------------------------------
// Wire converter (services/convert/release.go ToAPIRelease + URL methods)
// ---------------------------------------------------------------------------

function isoOrZero(date: Date | null): string {
  return date === null ? "0001-01-01T00:00:00Z" : date.toISOString();
}

function releaseUrls(pair: RepositoryWithOwner, origin: string, row: ReleaseRow): {
  url: string;
  htmlUrl: string;
  tarballUrl: string;
  zipballUrl: string;
  uploadUrl: string;
} {
  const apiRepoUrl = `${origin}/api/v1/repos/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const htmlRepoUrl = `${origin}/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const tag = encodeURIComponent(row.tagName);
  return {
    url: `${apiRepoUrl}/releases/${row.id}`,
    htmlUrl: `${htmlRepoUrl}/releases/tag/${tag}`,
    tarballUrl: `${htmlRepoUrl}/archive/${tag}.tar.gz`,
    zipballUrl: `${htmlRepoUrl}/archive/${tag}.zip`,
    uploadUrl: `${apiRepoUrl}/releases/${row.id}/assets`,
  };
}

/**
 * `convert.ToAPIRelease` — the publisher row is fetched per render (upstream
 * `release.LoadAttributes` + `ToAuthor`); assets are the empty Attachment
 * list until the R2 asset wave (SPEC-0004 open question 3).
 */
export async function toApiRelease(d1: D1Database, viewer: Viewer, pair: RepositoryWithOwner, row: ReleaseRow): Promise<Release> {
  const publisherRow =
    row.publisherId > 0
      ? await drizzle(d1).select().from(users).where(eq(users.id, row.publisherId)).get()
      : undefined;
  const author: User | null = publisherRow === undefined ? null : apiUserFromRow(publisherRow, viewer);
  const urls = releaseUrls(pair, viewer.origin, row);
  return {
    id: row.id,
    tag_name: row.tagName,
    target_commitish: row.target ?? "",
    name: row.title,
    body: row.note ?? "",
    url: urls.url,
    html_url: urls.htmlUrl,
    tarball_url: urls.tarballUrl,
    zipball_url: urls.zipballUrl,
    upload_url: urls.uploadUrl,
    draft: row.isDraft,
    prerelease: row.isPrerelease,
    created_at: isoOrZero(row.createdAt),
    published_at: row.isDraft ? null : row.publishedUnix === 0 ? null : new Date(row.publishedUnix * 1000).toISOString(),
    author,
    assets: [],
  };
}
