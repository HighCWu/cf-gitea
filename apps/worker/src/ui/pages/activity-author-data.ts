/**
 * The repository ACTIVITY author feed — the parity survey's last small
 * M-tier remainder row: the per-author commit-activity JSON the official
 * bundle's activity page fetches for its "Top authors" chart, upstream
 *
 *   GET /{owner}/{repo}/activity_author_data            web.go:1684
 *   GET /{owner}/{repo}/activity_author_data/{period}   web.go:1686
 *                                   repo.ActivityAuthors
 *                                   (routers/web/repo/activity.go:83-110)
 *
 * ## Handler semantics (cited)
 *
 * `timeUntil = time.Now()` (activity.go:84) and the `{period}` path segment
 * picks the window (activity.go:85-105): daily −24h, halfweekly −72h,
 * weekly −168h, monthly AddDate(0,−1,0), quarterly −3 months, semiyearly
 * −6 months, yearly −1 year; ANY other segment (including the bare route,
 * which has no period at all) falls to the WEEKLY default — upstream has no
 * 4xx arm here. The route group carries `repo.MustBeNotEmpty`
 * (web.go:1687): an empty repo 404s. The answer is `ctx.JSON(200, authors)`
 * — content type `application/json;charset=utf-8`
 * (services/context/base.go:115-117) with the middleware's zero-option prod
 * Cache-Control `max-age=0, private, must-revalidate`
 * (modules/httpcache/httpcache.go:31-33; the commit-contained-refs
 * precedent pair — upstream caches nothing, the chart refetches per page
 * view). Upstream sets no ETag/Last-Modified on this family.
 *
 * ## The JSON shape (the ported contract)
 *
 * `ActivityAuthorData` (models/activities/repo_activity.go:14-20) marshals
 * as an ARRAY of
 *
 *     { "name": …, "login": …, "avatar_link": …, "home_link": …,
 *       "commits": N }
 *
 * — NOTE: `commits` only; the survey's "additions/deletions" belong to the
 * ACTIVITY PAGE's `CodeActivityStats` (modules/git/repo_stats.go:17-27),
 * not this feed. `name` = `u.DisplayName()` (user.go:476-482 — FullName
 * when set, else the username; ours reads users.displayName, the
 * settings-form-written full-name column, then users.fullName, then the
 * username), `login` = `u.LowerName`, `home_link` = `/{username}` —
 * RELATIVE, `HomeLink()` keeps it sub-path relative (user.go:342-344);
 * `avatar_link` = `u.AvatarLink(ctx)` — ABSOLUTE, MakeAbsoluteURL prefixes
 * the request host (models/user/avatar.go:83-87, httplib
 * server_request.go:161-169), so the loader takes `origin`.
 *
 * ## The aggregation (upstream → ours)
 *
 * Upstream: `GetActivityStatsTopAuthors(repo, timeFrom, 10)`
 * (repo_activity.go:85-128) over `git log --no-merges
 * --pretty=format:…%aN%n%aE%n --branches=* --since=<RFC3339>`
 * (GetCodeActivityAuthors, modules/git/repo_stats.go:72-79): non-merge
 * commits reachable from ALL branches since the window, counted per
 * LOWERCASED AUTHOR EMAIL (first-seen author name wins — repo_stats.go
 * case 4), empty emails skipped (repo_activity.go:95), each email mapped
 * through GetUserByEmail (user.go:1372-1402 — the activated email_address
 * table + the noreply arm), per-USER accumulation (one user's two commit
 * emails merge into one entry), unmapped emails become per-email GHOST
 * entries with `NewGhostUser().AvatarLink(ctx)` (repo_activity.go:93-104;
 * ghost id −1 → DefaultAvatarLink, models/user/avatar.go:49-52 →
 * /assets/avatar_default.png), sorted by commits DESC, top 10.
 *
 * Ours, over the engine boundary (no `--since`, no `--branches=*` RPC):
 * `listRefs` gives the branch universe; per branch (name-sorted, capped)
 * `listLog(branch, {ofs, n})` pages the engine's COMMITTER-TIME-ORDERED
 * walk (packages/git-engine repo.ts walkLog — a date-ordered priority walk
 * over all parents, exactly `git log --date-order`), and the window filter
 * runs client-of-engine on committer time (git's `--since` filters commit
 * date too), merge commits (parents.length > 1) skipped client-side — the
 * `--no-merges` arm. Commits reachable from several branches DEDUPLICATE
 * by oid (one `--branches=*` walk counts them once). Documented caps:
 *   - ACTIVITY_MAX_BRANCHES = 50 branches (name-sorted, deterministic)
 *     — upstream's `--branches=*` is unbounded;
 *   - ACTIVITY_BRANCH_COMMIT_CAP = 200 recent commits per branch
 *     (2 × the engine's listLog page cap of 100), with an EARLY STOP once
 *     a page's oldest commit predates the window (date-ordered walk:
 *     deeper entries are older, modulo rebase-dated commits — the same
 *     approximation upstream's own traversal pruning makes);
 *   - ACTIVITY_AUTHOR_TOP = 10, upstream's literal count argument
 *     (activity.go:109).
 * Engine transport failure resolves null → the mount's 404 arm, the
 * §4.5 aux-JSON family convention (documented divergence: upstream
 * ServerErrors 500).
 *
 * Email → account resolution follows the LANDED convention
 * (api/services/git-models.ts usernamesByEmail): one case-insensitive
 * `users.email` IN-query. Upstream's activated-email_address and noreply
 * arms (user.go:1379-1397) are not landed — documented reduction.
 *
 * Mapped users' avatar rides the LANDED chain `avatarLinkWithSize(bucket,
 * user, 0)` (services/avatars.ts — AvatarLinkWithSize,
 * models/user/avatar.go:49-79): at the frozen DISABLE_GRAVATAR=true the
 * auto-generate arm seeds the identicon R2 object on first link — the
 * same write-on-link side effect upstream's GenerateRandomAvatar has;
 * ghost entries link defaultAvatarLink(). Link is made absolute with the
 * request origin (upstream MakeAbsoluteURL).
 *
 * Sorting: commits DESC with a name-asc tiebreak — upstream's sort.Slice
 * is unstable and the feed is a chart source, so the tiebreak is cosmetic
 * determinism (the commit-contained-refs divergence pattern).
 *
 * ## HANDOFF NOTE (for the wiring wave — index.ts is orchestrator-owned)
 *
 * Route family `activity-author-data`: the two patterns
 * `/{owner}/{repo}/activity_author_data` and
 * `/{owner}/{repo}/activity_author_data/{period}` (period segment OPTIONAL
 * — the bare route passes null). Mount is the commit-contained-refs
 * recipe verbatim (src/ui/index.ts:968, 1605, 2805, 5212-5233):
 *   1. `import { activityAuthorDataResponse, loadActivityAuthorData } from
 *      "./pages/activity-author-data";`
 *   2. add `family: "activity-author-data"` to the UiRoute union with
 *      `{ owner; repo; period: string | null }`;
 *   3. parse arm: `activity_author_data` exact path → period null;
 *      `activity_author_data/{segment}` → the raw segment (parseActivity
 *      Period defaults unknowns, no 4xx — upstream parity);
 *   4. handler: `resolveUiRequest` → family drift guard →
 *      `loadActivityAuthorData(c.env, repo, route.period, { origin:
 *      url.origin })` (the resolved UiRequest already carries `url`) →
 *      null answers `c.html(renderNotFound(ctx), 404)`; else
 *      `respond(activityAuthorDataResponse(data))`.
 * Not a page — the aux-JSON sibling of commit-contained-refs.
 */

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { CommitJson, RefsResult } from "@cf-gitea/git-engine";

import { engineReads } from "../../api/services/engine";
import { users } from "../../db/schema";
import { avatarLinkWithSize, defaultAvatarLink } from "../../services/avatars";
import { pathEscapeSegments } from "../page-data";

/** One feed entry — `ActivityAuthorData`
 *  (models/activities/repo_activity.go:14-20); the field order is the Go
 *  struct's marshal order. */
export interface ActivityAuthorData {
  name: string;
  login: string;
  avatar_link: string;
  home_link: string;
  commits: number;
}

/** Upstream's literal top-N (repo.ActivityAuthors → count 10,
 *  routers/web/repo/activity.go:109). */
export const ACTIVITY_AUTHOR_TOP = 10;

/** Branch-universe cap — upstream `--branches=*` is unbounded; ours bounds
 *  the per-feed RPC fan-out (the module doc's documented cap). */
export const ACTIVITY_MAX_BRANCHES = 50;

/** Per-branch recent-commit cap = 2 × the engine's listLog page cap of
 *  100 (packages/git-engine repo.ts `Math.min(…, 100)`). */
export const ACTIVITY_BRANCH_COMMIT_CAP = 200;

/** The engine's own listLog page size ceiling (repo.ts listLog). */
const ENGINE_LOG_PAGE = 100;

/** 8-wide batches per DO round-trip group — the commit-contained-refs
 *  batching convention against one cell. */
const BRANCH_BATCH = 8;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Go AddDate's month arithmetic on UTC dates: day-of-month rollover
 *  normalizes the same way (Jan 31 − 1mo = Mar 2/3, exactly Go's rule). */
function addUtcMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/**
 * The `{period}` path segment → `{period, from}` — the activity.go:85-105
 * switch verbatim (the ActivityAuthors arm, where unknowns are the WEEKLY
 * default; upstream has no 4xx arm). `null` = the bare route. Month/quarter
 * windows ride Go AddDate month arithmetic (`addUtcMonths`).
 */
export function parseActivityPeriod(segment: string | null, now: Date): { period: string; from: Date } {
  switch (segment) {
    case "daily":
      return { period: "daily", from: new Date(now.getTime() - DAY_MS) };
    case "halfweekly":
      return { period: "halfweekly", from: new Date(now.getTime() - 72 * HOUR_MS) };
    case "monthly":
      return { period: "monthly", from: addUtcMonths(now, -1) };
    case "quarterly":
      return { period: "quarterly", from: addUtcMonths(now, -3) };
    case "semiyearly":
      return { period: "semiyearly", from: addUtcMonths(now, -6) };
    case "yearly":
      return { period: "yearly", from: addUtcMonths(now, -12) };
    default:
      // "weekly" and EVERY unknown segment (activity.go:105's default arm).
      return { period: "weekly", from: new Date(now.getTime() - 168 * HOUR_MS) };
  }
}

/** The loader's repo subset (the caller's resolved row). */
export type ActivityAuthorRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
};

/** The email-keyed per-author count (the git layer's map — repo_stats.go
 *  case 4 keys by LOWERCASED email, first-seen author name wins). */
interface AuthorCount {
  name: string;
  email: string;
  commits: number;
}

/** The users row slice the avatar chain + the entry fields read. */
type AuthorUserRow = Pick<
  typeof users.$inferSelect,
  "id" | "username" | "usernameLower" | "email" | "displayName" | "fullName" | "avatarEmail" | "useCustomAvatar"
>;

/** Upstream `u.DisplayName()` (user.go:476-482): the full name when set,
 *  else the username. Ours reads users.displayName (the settings form's
 *  full-name column, user-settings.tsx:173) then users.fullName (the
 *  schema's literal upstream-FullName column) then the username. */
function authorDisplayName(row: AuthorUserRow): string {
  const full = (row.displayName ?? row.fullName ?? "").trim();
  return full === "" ? row.username : full;
}

/** Walk one branch's recent commits within the window (the module doc's
 *  caps). Returns the in-window non-merge commits, deduplicated later by
 *  oid across branches. */
async function branchWindowCommits(
  reads: ReturnType<typeof engineReads>,
  branch: string,
  cutoffMs: number,
): Promise<CommitJson[]> {
  const out: CommitJson[] = [];
  for (let ofs = 0; ofs < ACTIVITY_BRANCH_COMMIT_CAP; ofs += ENGINE_LOG_PAGE) {
    const page = await reads.listLog(branch, { ofs, n: ENGINE_LOG_PAGE });
    if (page === null || page.commits.length === 0) break; // transport failure / walk end
    for (const commit of page.commits) {
      if (commit.committer.time * 1000 < cutoffMs) continue; // --since arm (client-of-engine)
      if (commit.parents.length > 1) continue; // --no-merges arm
      out.push(commit);
    }
    const oldest = page.commits[page.commits.length - 1];
    if (!page.more || oldest === undefined || oldest.committer.time * 1000 < cutoffMs) break; // date-order early stop
  }
  return out;
}

/**
 * Load the top-author feed. `null` = the 404 family: the MustBeNotEmpty
 * gate (web.go:1687) or an engine transport failure (the §4.5 aux-JSON
 * convention — upstream divergence documented in the module header).
 * An empty ARRAY is upstream's no-activity-in-window answer
 * (`ctx.JSON(200, [])`).
 */
export async function loadActivityAuthorData(
  env: Env,
  repo: ActivityAuthorRepo,
  periodSegment: string | null,
  options: { origin: string; now?: Date },
): Promise<ActivityAuthorData[] | null> {
  if (repo.isEmpty) return null; // MustBeNotEmpty (web.go:1687)

  const { from } = parseActivityPeriod(periodSegment, options.now ?? new Date());
  const cutoffMs = from.getTime();

  const reads = engineReads(env, repo);
  const refs: RefsResult | null = await reads.listRefs();
  if (refs === null) return null; // transport failure (documented divergence)
  if (refs.head === null) return null; // unborn HEAD — the MustBeNotEmpty substance
  const branches = refs.refs
    .map((ref) => ref.name)
    .filter((name) => name.startsWith("refs/heads/"))
    .sort() // deterministic scan order (the -creatordate divergence pattern)
    .slice(0, ACTIVITY_MAX_BRANCHES);
  if (branches.length === 0) return null;

  // The all-branch scan, deduplicated by oid (one --branches=* walk counts
  // a commit reachable from several branches once). 8-wide batches per DO.
  const seenOids = new Set<string>();
  const byEmail = new Map<string, AuthorCount>();
  for (let i = 0; i < branches.length; i += BRANCH_BATCH) {
    const groups = await Promise.all(
      branches.slice(i, i + BRANCH_BATCH).map((branch) => branchWindowCommits(reads, branch, cutoffMs)),
    );
    for (const group of groups) {
      for (const commit of group) {
        if (seenOids.has(commit.oid)) continue;
        seenOids.add(commit.oid);
        const email = commit.author.email.toLowerCase();
        if (email === "") continue; // repo_activity.go:95's empty-email skip
        const known = byEmail.get(email);
        if (known === undefined) {
          byEmail.set(email, { name: commit.author.name, email, commits: 1 });
        } else {
          known.commits += 1;
        }
      }
    }
  }

  // The email → account resolution, one batched case-insensitive users read
  // (the usernamesByEmail convention; upstream's email_address/noreply arms
  // are the documented reduction).
  const rows: AuthorUserRow[] =
    byEmail.size === 0
      ? []
      : await drizzle(env.DB)
          .select({
            id: users.id,
            username: users.username,
            usernameLower: users.usernameLower,
            email: users.email,
            displayName: users.displayName,
            fullName: users.fullName,
            avatarEmail: users.avatarEmail,
            useCustomAvatar: users.useCustomAvatar,
          })
          .from(users)
          .where(inArray(sql`lower(${users.email})`, [...byEmail.keys()]))
          .all();
  const userByEmail = new Map<string, AuthorUserRow>();
  for (const row of rows) {
    if (row.email !== null) userByEmail.set(row.email.toLowerCase(), row);
  }

  // The per-USER merge (repo_activity.go:98-118): mapped emails accumulate
  // into one entry keyed by user id; unmapped emails stay per-email ghost
  // entries (upstream's unknownUserID-- keys, insertion-ordered here).
  const merged = new Map<string, { entry: ActivityAuthorData; user: AuthorUserRow | null; commits: number }>();
  for (const author of byEmail.values()) {
    const user = userByEmail.get(author.email);
    if (user === undefined) {
      merged.set(`ghost:${author.email}`, {
        entry: {
          name: author.name,
          login: "",
          avatar_link: "", // filled below — one avatar chain walk per entry
          home_link: "",
          commits: author.commits,
        },
        user: null,
        commits: author.commits,
      });
      continue;
    }
    const existing = merged.get(`user:${user.id}`);
    if (existing === undefined) {
      merged.set(`user:${user.id}`, {
        entry: {
          name: authorDisplayName(user),
          login: user.usernameLower,
          avatar_link: "",
          home_link: `/${pathEscapeSegments(user.username)}`, // HomeLink() stays relative (user.go:342-344)
          commits: author.commits,
        },
        user,
        commits: author.commits,
      });
    } else {
      existing.commits += author.commits;
    }
  }

  // The avatar links — absolutized like upstream's AvatarLink
  // (models/user/avatar.go:83-87): mapped users ride the landed chain,
  // ghosts link the default avatar (ghost id −1 → DefaultAvatarLink).
  await Promise.all(
    [...merged.values()].map(async (slot) => {
      const link =
        slot.user === null
          ? defaultAvatarLink()
          : await avatarLinkWithSize(env.REPO_PACKS, slot.user, 0);
      slot.entry.avatar_link = new URL(link, options.origin).toString();
    }),
  );

  // Sort commits DESC (upstream) with the cosmetic name-asc tiebreak, top N.
  const list = [...merged.values()].map((slot) => slot.entry);
  list.sort((a, b) => {
    if (a.commits !== b.commits) return b.commits - a.commits;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return list.slice(0, ACTIVITY_AUTHOR_TOP);
}

/**
 * The feed Response — ctx.JSON's `application/json;charset=utf-8`
 * (services/context/base.go:115-117) plus the middleware's zero-option prod
 * Cache-Control (modules/httpcache/httpcache.go:31-33; the
 * commit-contained-refs precedent pair — the official bundle caches
 * nothing here, the chart refetches per page view).
 */
export function activityAuthorDataResponse(data: ActivityAuthorData[]): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
