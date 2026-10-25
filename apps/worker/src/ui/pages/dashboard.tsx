/**
 * The site root, `/` — pages wave 9 (SPEC-0008 U3 extension): upstream
 * `Home` (routers/web/home.go:26-44) — a signed-in viewer gets the
 * dashboard, an anonymous viewer the landing page. This module owns both
 * halves; the router (index.ts) only resolves the session and dispatches on
 * the viewer kind.
 *
 * ## The landing half (upstream templates/home.tmpl, anonymous)
 *
 * `.page-content.home`: the centered hero (logo, app-name h1, the
 * "startpage.app_desc" tagline h2) and the feature sections reduced to
 * headings + paragraphs (upstream's h1 section headers render as h2 — the
 * §5.5 one-h1 rule; the outbound links keep their upstream targets —
 * external links are not dead links, §2.4.1).
 *
 * ## The dashboard half (upstream templates/user/dashboard.tmpl, signed in)
 *
 * `.page-content.dashboard.feeds` with the upstream `flex-container` split:
 * `.flex-container-main` (the feeds column) and `#dashboard-repo-list
 * .flex-container-sidebar` (the repo lists), both reduced honestly:
 *
 * - **Recent activity** (feeds.tmpl degraded): upstream renders the
 *   action-feed pipeline (the activity feed service). No such service is
 *   landed; the brief's sanctioned read is the DERIVED-THREAD query of the
 *   notifications routes (src/api/routes/notifications.ts — threads derived
 *   over issues/comments/watchers/subscriptions at read time). That query's
 *   functions are module-private to the route file, so the dashboard
 *   re-issues its predicate set here verbatim (the scalar-max
 *   last-activity expression, the recipient disjunction, the
 *   `updated DESC, id DESC` ordering) at a reduced projection: the five
 *   most recent threads as issue/PR lines. Actions the model does not
 *   carry (pushes, repo creates — feed-only rows upstream) simply never
 *   appear; nothing is fabricated.
 * - **Repositories** (dashboard/repolist.tmpl degraded): the viewer's own
 *   repositories (the owner themself — every row grants, readGrant's
 *   isOwner arm). Upstream's Vue widget (search/filter/org switcher/
 *   paging) reduces to a static list; org-owned and collaborative repos
 *   are not listed (no landed org-repos-for-doer / collaborator listing
 *   read — the org home serves org repos per org).
 * - **Watched Repositories** (the brief's second list; upstream has no
 *   dashboard section at this pin): `repo_watchers` rows of the viewer
 *   joined to their repositories, filtered through the SHARED `readGrant`
 *   predicate (git-http/acl.ts — the same grant a repo page resolves, so a
 *   watched repo the viewer can no longer read never surfaces). Rows reuse
 *   the shared list-row component (the explore list's shape).
 *
 * ## Documented v1 degradations (§6 method — data without a landed source)
 *
 * - The dashboard navbar (user/dashboard/navbar.tmpl — the context-user
 *   switcher, org/team filters, the Issues/Pulls/Milestones dashboard tabs)
 *   is not rendered: the switcher needs the org list, the tabs need their
 *   dashboard pages (dead links forbidden, §2.4.1). The shell navbar
 *   already carries the signed-in identity.
 * - The heatmap, the feeds pager and the repo-list search/filter/paging
 *   widget are not rendered (no heatmap store, no feed pagination model, no
 *   widget backing). Lists cap at DASHBOARD_LIST_LIMIT rows, slug
 *   alphabetical (the landed list-order convention).
 * - Row counters reuse the shared list row's open-pulls chip; stars/forks
 *   have no D1 counters (§3.1).
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { readGrant } from "../../git-http/acl";
import { issueSubscriptions, issues, repoSettings, repoWatchers, repositories, users } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { OrgRepoListItem, type OrgHomeRepoItem } from "./org-home";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { Viewer } from "../viewer";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the orgHomeLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const dashboardLocale = {
  activity: "Recent activity", // cf-gitea addition (no upstream key at the pin)
  activity_empty: "No recent activity.", // cf-gitea addition
  my_repos: "Repositories", // "home.my_repos"
  watched_repos: "Watched Repositories", // cf-gitea addition (the brief's second list)
  watched_empty: "No watched repositories.", // cf-gitea addition
  repos_empty: "No repositories yet.", // "org.repos.empty" shape, dashboard arm
  landing_tagline: "A painless, self-hosted Git service", // "startpage.app_desc"
  landing_install: "Easy to install", // "startpage.install"
  landing_platform: "Cross-platform", // "startpage.platform"
  landing_lightweight: "Lightweight", // "startpage.lightweight"
  landing_free: "Free and open software", // cf-gitea addition
} as const;

/** The list cap (upstream `setting.UI.User.RepoPagingNum` = 15 — the same
 *  paging setting the owner homes render with; the widget's own pager is
 *  not rendered, the cap bounds the read instead). */
export const DASHBOARD_LIST_LIMIT = 15;

/** The recent-activity line cap (the feeds column, reduced to one page). */
export const DASHBOARD_ACTIVITY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Dashboard data (§3.2 — direct D1/service reads, never a self-fetch)
// ---------------------------------------------------------------------------

/** One repo-list row: the repository, its owner's visibility (the
 *  internal-badge rule shared/repo/list.tmpl carries), the settings
 *  description. */
export interface DashboardRepoItem {
  repo: typeof repositories.$inferSelect;
  ownerVisibility: "public" | "limited" | "private";
  description: string;
}

/** One recent-activity line (the derived-thread projection). */
export interface DashboardActivityItem {
  /** The underlying issues.id (the derived thread id, notifications.ts). */
  issueId: number;
  index: number;
  title: string;
  isPull: boolean;
  isClosed: boolean;
  ownerNamespace: string;
  slug: string;
  /** Unix seconds of the last foreign-authored activity (the derived
   *  thread's lastActivity — notifications.ts lastActivityExpr). */
  lastActivity: number;
}

/** The dashboard render inputs. */
export interface DashboardData {
  myRepos: DashboardRepoItem[];
  watched: DashboardRepoItem[];
  activity: DashboardActivityItem[];
}

/**
 * Last foreign-authored activity on an issue — notifications.ts
 * `lastActivityExpr` verbatim (the scalar two-argument max over the
 * correlated latest-foreign-comment time and the foreign-poster creation
 * time; a scalar `max(a, b)` needs no GROUP BY).
 */
function lastActivityExpr(userId: number): ReturnType<typeof sql> {
  return sql`max(
    coalesce((select max(coalesce(c.updated_unix, c.created_unix)) from comments c
      where c.issue_id = ${issues.id} and (c.poster_id is null or c.poster_id <> ${userId})), 0),
    case when ${issues.posterId} is not null and ${issues.posterId} <> ${userId}
      then coalesce(${issues.createdAt}, 0) else 0 end
  )`;
}

/**
 * The recipient disjunction — notifications.ts `recipientExpr` verbatim
 * (watcher, repo owner, poster, issue subscriber, past commenter). The
 * repoWatchers / issueSubscriptions left joins must be in scope.
 */
function recipientExpr(userId: number): ReturnType<typeof sql> {
  return sql`(
    ${repoWatchers.userId} is not null
    or ${repositories.ownerId} = ${userId}
    or ${issues.posterId} = ${userId}
    or ${issueSubscriptions.userId} is not null
    or exists (select 1 from comments pc where pc.issue_id = ${issues.id} and pc.poster_id = ${userId})
  )`;
}

/** Batched descriptions for one page of repos (the org-home loader pattern). */
async function descriptionsFor(d1: D1Database, repoIds: string[]): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>();
  if (repoIds.length > 0) {
    const rows = await drizzle(d1)
      .select({ repoId: repoSettings.repoId, description: repoSettings.description })
      .from(repoSettings)
      .where(inArray(repoSettings.repoId, repoIds))
      .all();
    for (const row of rows) descriptions.set(row.repoId, row.description);
  }
  return descriptions;
}

/**
 * Load the dashboard (§3.2): the viewer's user row (profile visibility for
 * the list badges), the own-repo page (isOwner grants every row), the
 * watched page (`readGrant`-filtered — the shared predicate, so a watched
 * repo reads exactly like its repo page would), and the derived-thread
 * activity read.
 */
export async function loadDashboardData(d1: D1Database, viewer: Viewer): Promise<DashboardData> {
  if (viewer.kind !== "user") throw new Error("loadDashboardData requires a signed-in viewer");
  const db = drizzle(d1);
  const user = await db.select().from(users).where(eq(users.id, viewer.id)).get();
  if (user === undefined) throw new Error("the session doer vanished");
  const doer = { id: viewer.id, isAdmin: viewer.isAdmin };

  // Repositories (repolist.tmpl degraded): the viewer's own rows. The owner
  // is the viewer themself, so every row grants (readGrant's isOwner arm).
  const ownedRows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.ownerId, user.id))
    .orderBy(repositories.slug)
    .limit(DASHBOARD_LIST_LIMIT);

  // Watched repositories (the brief's second list): watcher rows joined to
  // their repo + owner, ordered owner-then-slug, capped, then filtered
  // through the SHARED readGrant predicate (repo-view.ts's posture — one
  // grant definition, no local re-derivation).
  const watchedRows = await db
    .select({ repo: repositories, owner: users })
    .from(repoWatchers)
    .innerJoin(repositories, eq(repositories.id, repoWatchers.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(eq(repoWatchers.userId, user.id))
    .orderBy(repositories.ownerNamespace, repositories.slug)
    .limit(DASHBOARD_LIST_LIMIT);
  const watchedVisible = watchedRows.filter(
    (row) =>
      row.owner.status === "active" &&
      readGrant({
        repoVisibility: row.repo.visibility,
        owner: { id: row.owner.id, status: row.owner.status },
        ownerVisibility: row.owner.visibility,
        doer,
      }),
  );

  const [myDescriptions, watchedDescriptions, activity] = await Promise.all([
    descriptionsFor(d1, ownedRows.map((row) => row.id)),
    descriptionsFor(d1, watchedVisible.map((row) => row.repo.id)),
    loadRecentActivity(d1, user.id),
  ]);

  return {
    myRepos: ownedRows.map((row) => ({
      repo: row,
      ownerVisibility: user.visibility,
      description: myDescriptions.get(row.id) ?? "",
    })),
    watched: watchedVisible.map((row) => ({
      repo: row.repo,
      ownerVisibility: row.owner.visibility,
      description: watchedDescriptions.get(row.repo.id) ?? "",
    })),
    activity,
  };
}

/**
 * The five most recent derived notification threads (the notifications
 * routes' read, reduced): recipient ∧ foreign-activity > 0, ordered
 * `lastActivity DESC, id DESC` — the upstream ToOrders shape
 * (notification_list.go:65-67) the landed route pins.
 */
export async function loadRecentActivity(d1: D1Database, userId: number): Promise<DashboardActivityItem[]> {
  const lastActivity = lastActivityExpr(userId);
  const rows = await drizzle(d1)
    .select({
      issueId: issues.id,
      index: issues.index,
      title: issues.title,
      isPull: issues.isPull,
      isClosed: issues.isClosed,
      ownerNamespace: repositories.ownerNamespace,
      slug: repositories.slug,
      lastActivity: sql<number>`(${lastActivity})`,
    })
    .from(issues)
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .leftJoin(repoWatchers, and(eq(repoWatchers.repoId, issues.repoId), eq(repoWatchers.userId, userId)))
    .leftJoin(
      issueSubscriptions,
      and(
        eq(issueSubscriptions.issueId, issues.id),
        eq(issueSubscriptions.userId, userId),
        eq(issueSubscriptions.isWatching, true),
      ),
    )
    .where(sql`(${lastActivity}) > 0 and ${recipientExpr(userId)}`)
    .orderBy(desc(sql`(${lastActivity})`), desc(issues.id))
    .limit(DASHBOARD_ACTIVITY_LIMIT);
  return rows.map((row) => ({ ...row, isPull: row.isPull === true, isClosed: row.isClosed === true }));
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The full-document render — the anonymous landing (the render.tsx pattern
 *  — `index.ts` stays a pure-TS router module, so the JSX invocation lives
 *  beside the component). */
export function renderLandingPage(ctx: UiContext): string {
  return renderPage(<LandingPage ctx={ctx} />);
}

/** The anonymous landing (upstream home.tmpl reduced — module header). */
export function LandingPage(props: { ctx: UiContext }) {
  const { ctx } = props;
  return (
    <BaseLayout ctx={ctx} title="Home" pageClass="home">
      <div class="ui container">
        <div class="center">
          <img class="logo" width="220" height="220" src="/assets/img/logo.svg" alt="Logo" />
          <div class="hero">
            <h1 class="ui icon header title">cf-gitea</h1>
            <h2>{dashboardLocale.landing_tagline}</h2>
          </div>
        </div>
        <div class="ui stackable middle very relaxed page grid">
          <div class="eight wide center column">
            <h2 class="hero ui icon header">{dashboardLocale.landing_install}</h2>
            <p class="large">
              Simply{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://docs.gitea.com/installation/install-from-binary">
                run the binary
              </a>{" "}
              for your platform, ship it with{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://github.com/go-gitea/gitea/tree/master/docker">
                Docker
              </a>
              , or get it{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://docs.gitea.com/installation/install-from-package">
                packaged
              </a>
              .
            </p>
          </div>
          <div class="eight wide center column">
            <h2 class="hero ui icon header">{dashboardLocale.landing_platform}</h2>
            <p class="large">
              Gitea runs anywhere{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://go.dev/">
                Go
              </a>{" "}
              can compile for: Windows, macOS, Linux, ARM, etc. Choose the one you love!
            </p>
          </div>
        </div>
        <div class="ui stackable middle very relaxed page grid">
          <div class="eight wide center column">
            <h2 class="hero ui icon header">{dashboardLocale.landing_lightweight}</h2>
            <p class="large">
              Gitea has low minimal requirements and can run on an inexpensive Raspberry Pi. Save your machine energy!
            </p>
          </div>
          <div class="eight wide center column">
            <h2 class="hero ui icon header">{dashboardLocale.landing_free}</h2>
            <p class="large">
              The backend is self-hostable source code; the frontend is the unmodified official Gitea bundle.{" "}
              <a href="/assets/licenses.txt">Licenses</a>
            </p>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The activity feed's state glyph (the shared/issueicon.tmpl reduction —
 *  the PR family collapses to the open PR glyph: merged/WIP need the
 *  pull_requests extension row this projection does not carry). */
function ActivityIcon(props: { item: DashboardActivityItem }) {
  const { item } = props;
  if (item.isPull) return <Icon name="octicon-git-pull-request" class="tw-text-green" />;
  return item.isClosed ? (
    <Icon name="octicon-issue-closed" class="tw-text-red" />
  ) : (
    <Icon name="octicon-issue-opened" class="tw-text-green" />
  );
}

/** The feeds column (feeds.tmpl degraded to the derived-thread lines). */
export function DashboardActivity(props: { data: DashboardData }) {
  const { activity } = props.data;
  return (
    <div>
      <h2>{dashboardLocale.activity}</h2>
      {activity.length === 0 ? (
        <p class="tw-text-placeholder-text">{dashboardLocale.activity_empty}</p>
      ) : (
        <div id="activity-feed" class="flex-divided-list items-with-main">
          {activity.map((item) => {
            const repoLink = `/${item.ownerNamespace}/${item.slug}`;
            return (
              <div class="item">
                <div class="item-leading">
                  <div class="flex-text-inline tw-mt-[3px]">
                    <ActivityIcon item={item} />
                  </div>
                </div>
                <div class="item-main">
                  <div class="item-header">
                    <a class="list-item-large-title" href={`${repoLink}/${item.isPull ? "pulls" : "issues"}/${item.index}`}>
                      {item.title} #{item.index}
                    </a>
                  </div>
                  <div class="item-body tw-gap-2">
                    <a href={repoLink}>
                      {item.ownerNamespace}/{item.slug}
                    </a>
                    <TimeSince unixSeconds={item.lastActivity} tz="+0000" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One repo-list section: the header + the shared list rows (or the muted
 *  empty line). The shared row's internal-badge rule resolves per row from
 *  the item's ownerVisibility (a public repo under a private-visibility
 *  owner is "Internal" — exactly OrgRepoListItem's orgPrivate arm). */
function DashboardRepoList(props: { heading: string; items: DashboardRepoItem[]; emptyText: string }) {
  return (
    <div>
      <h2>{props.heading}</h2>
      {props.items.length === 0 ? (
        <p class="tw-text-placeholder-text">{props.emptyText}</p>
      ) : (
        <div class="flex-divided-list items-with-main">
          {props.items.map((item) => (
            <OrgRepoListItem
              orgLink={`/${item.repo.ownerNamespace}`}
              item={{ repo: item.repo, description: item.description } satisfies OrgHomeRepoItem}
              orgPrivate={item.repo.visibility === "public" && item.ownerVisibility === "private"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderDashboardPage(ctx: UiContext, data: DashboardData): string {
  return renderPage(<DashboardPage ctx={ctx} data={data} />);
}

/** The signed-in dashboard (§2.4.1 discriminator: `dashboard feeds`). */
export function DashboardPage(props: { ctx: UiContext; data: DashboardData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title="Dashboard" pageClass="dashboard feeds">
      <div class="ui container flex-container">
        <div class="flex-container-main">
          <DashboardActivity data={data} />
        </div>
        <div id="dashboard-repo-list" class="flex-container-sidebar">
          <DashboardRepoList heading={dashboardLocale.my_repos} items={data.myRepos} emptyText={dashboardLocale.repos_empty} />
          <DashboardRepoList
            heading={dashboardLocale.watched_repos}
            items={data.watched}
            emptyText={dashboardLocale.watched_empty}
          />
        </div>
      </div>
    </BaseLayout>
  );
}
