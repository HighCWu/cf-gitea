import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { releaseAssets, releases, users } from "../../db/schema";
import type { ReleaseRow } from "../../issues/service";
import { ApiError } from "../errors";
import type { Release } from "../models/release";
import type { User } from "../models/user";
import { apiUserFromRow, type RepositoryWithOwner, type Viewer } from "./repository";

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
 * Engine boundary (documented, per the batch brief — releases are D1-only
 * until assets): upstream's CreateRelease/EditRelease also create/rename the
 * GIT TAG through the engine commit-builder (SPEC-0004 §3.4) and DeleteRelease
 * deletes it; here `target_commitish`/`tag_name` are D1 values, `sha1` stays
 * null, and the git tag itself is untouched — the engine wave closes this.
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
