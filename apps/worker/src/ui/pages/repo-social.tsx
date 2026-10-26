/**
 * The repo social list pages — pages wave 24 (the UI-parity survey's bench
 * tier, docs/compat/ui-parity-survey.md — the third-ranked row, the
 * `.../forks|stars|watchers` trio):
 *
 *   GET /{owner}/{repo}/forks     survey family C, web.go:1759
 *                                 `m.Get("/forks", repo.Forks)`
 *   GET /{owner}/{repo}/stars     survey family F, web.go:1766
 *                                 `m.Get("/stars", starsEnabled, repo.Stars)`
 *   GET /{owner}/{repo}/watchers  survey family F, web.go:1767
 *                                 `m.Get("/watchers", repo.Watchers)`
 *
 * One module because the three share everything but the read: the same
 * group gate (web.go:1770's `optSignIn` + RepoAssignment — RequireSignInView
 * Strict is off at the pin, so all three are anonymous-capable; an invisible
 * repo 404-shells through the router's §2.5 read exactly like upstream's
 * RepoAssignment collapse), the same `setting.ItemsPerPage` = 40 pager
 * (modules/setting/repository.go:30 — RenderUserCards and Forks both size
 * with it), and — for stars/watchers — the SAME template: upstream's
 * repo.Stars renders tplWatchers, so both pages carry the literal
 * `repository watchers` pageClass and the repo/user_cards DOM.
 *
 * ## DOM contract (templates/repo/{forks,watchers}.tmpl + repo/user_cards.tmpl
 *  + shared/repo/list.tmpl at the pin)
 *
 * - Forks: `.page-content.repository forks`, the repo header (the shell's
 *   RepoHeader), then `.ui.container.fork-list` with the `h2.ui.dividing
 *   header` "Forks", the shared/repo/list rows and base/paginate. The fork
 *   rows render upstream's ShowRepoOwnerOnList arm — the OWNER name link
 *   before the repo link, because a fork's namespace is the row's whole
 *   point (forks rename into the forker's namespace) — which the landed
 *   OrgRepoListItem (org-home.tsx) does not render; this module carries its
 *   own row modeled on that DOM.
 * - Stars/Watchers: `.page-content.repository watchers` (tplWatchers serves
 *   both), then `.ui.container` with user_cards.tmpl: the `.user-cards`
 *   div, the `h2.ui.dividing header` (CardsTitle — "Stargazers" /
 *   "Watchers"), the `ul.list` of `li.item.ui.segment` cards and paginate.
 *   Per card: the avatar slot, the `h3.name.flex-text-block` display-name
 *   link, and the `.meta.flex-text-block` line — website (octicon-link +
 *   external anchor) else location (octicon-location) else the joined-on
 *   line (octicon-calendar + AbsoluteShort date).
 *
 * ## Who sees what
 *
 * The pages answer for any viewer who can read the repo (the §2.5 read
 * grant — upstream's RepoAssignment + the unit checks of the same group).
 * The LISTINGS narrow by the landed services' own visibility rules: the
 * forks read filters the reduced accessible-condition (public rows plus the
 * doer's own; the admin arm drops the filter — services/forks.ts listForks,
 * the GET /repos/{owner}/{repo}/forks arm), stars/watchers list every user
 * row (the social-lists.ts standing convention — every user row is public
 * until SPEC-0007's visibility model reaches the directory).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The card avatar is the placeholder person glyph, NOT a link (the
 *   org-members/explore avatar-slot rule — an icon-only link has no
 *   accessible name; the name link carries the navigation). Upstream's
 *   avatar img has no alt-bearing renderer here (the avatar pipeline does
 *   not exist — the repo header's §3.1 note).
 * - The per-card user-type label (user_type_label.tmpl) is unrendered: no
 *   bot accounts exist in this tier, and an org cannot star or watch (the
 *   services key stars/repo_watchers on a user session).
 * - The card meta's website anchor renders only http(s) URLs — Go's
 *   html/template would neutralize a javascript: href at emit time; the
 *   anchor-less fallback falls through to the location/joined arms.
 * - The fork rows carry the shared/repo/list trailing-count REDUCTION the
 *   landed OrgRepoListItem established: the stars count (the maintained
 *   `repositories.num_stars` column, migration 0030) and the pulls count
 *   render; the forks counter (no `num_forks` column yet) and the
 *   watch-options gear are unrendered.
 * - The `data-fetch-trigger` attribute on user_cards' root div (the bundle's
 *   star/watch action reload hook) is not reproduced — no such JS ships in
 *   this slice.
 * - Empty forks render shared/repo/list's else-arm text; empty stars and
 *   watchers render the bare empty ul (user_cards has no else arm
 *   upstream — kept verbatim).
 */

import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { listForks } from "../../api/services/forks";
import { listRepoStargazers, listRepoSubscribers } from "../../api/services/social-lists";
import type { RepositoryWithOwner, UserRow } from "../../api/services/repository";
import { repoSettings } from "../../db/schema";
import { userLink } from "../links";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { TimeSince } from "../components/file-list";
import { OrgHomePagination } from "./org-home";
import { formatDueDate } from "./milestones";

/** Page chrome text (component-local, the orgMembersLocale pattern —
 *  locale.ts is shared and not this wave's file; upstream locale keys cited). */
export const repoSocialLocale = {
  forks: "Forks", // "repo.forks"
  stargazers: "Stargazers", // "repo.stargazers"
  watchers: "Watchers", // "repo.watchers"
  joined_on: "Joined on", // "user.joined_on"
  repo_updated: "Updated", // "org.repo_updated"
  repo_archived: "Archived", // "repo.desc.archived"
  repo_private: "Private", // "repo.desc.private"
  repo_internal: "Internal", // "repo.desc.internal"
  pulls_aria: "Pull Requests", // "repo.pulls"
  stars_aria: "Stars", // "repo.stars"
  no_results: "No matching results found.", // "search.no_results"
} as const;

/** Upstream `setting.ItemsPerPage` (modules/setting/repository.go:30) — the
 *  RenderUserCards and Forks pager constant. */
export const SOCIAL_PAGE_SIZE = 40;

/** The trio's family tag — the parser's union member and the loader's read
 *  switch. */
export type RepoSocialFamily = "forks" | "stars" | "watchers";

/** One fork row: the repository + owner pair and the batched description
 *  (the explore loader's repoSettings read). */
export type RepoSocialFork = RepositoryWithOwner & { description: string };

/** The trio's shared render inputs. Exactly one of `forks`/`cards` carries
 *  rows (the family's arm); the other stays empty. */
export interface RepoSocialData {
  family: RepoSocialFamily;
  page: number;
  more: boolean;
  total: number;
  forks: RepoSocialFork[];
  cards: UserRow[];
}

/** The page title (upstream's `ctx.Data["Title"]` / CardsTitle). */
export function repoSocialTitle(family: RepoSocialFamily): string {
  return family === "forks" ? repoSocialLocale.forks : family === "stars" ? repoSocialLocale.stargazers : repoSocialLocale.watchers;
}

/**
 * Load one page of the trio (§3.2 — the landed services, never a self-fetch):
 * forks through `listForks` (the GET /repos/{owner}/{repo}/forks arm, the
 * viewer's reduced accessible-condition) plus the batched description read
 * (the explore loader pattern); stars/watchers straight through the landed
 * social-list reads. `?page=` rides the shared parsePageNumber.
 */
export async function loadRepoSocialData(
  d1: D1Database,
  repo: RepoRow,
  viewer: Viewer,
  family: RepoSocialFamily,
  params: URLSearchParams,
): Promise<RepoSocialData> {
  const page = parsePageNumber(params.get("page"));
  if (family === "forks") {
    const listing = await listForks(d1, repo.id, {
      page,
      pageSize: SOCIAL_PAGE_SIZE,
      doerLoginLower: viewer.kind === "user" ? viewer.username.toLowerCase() : null,
      isAdmin: viewer.kind === "user" ? viewer.isAdmin : false,
    });
    const descriptions = new Map<string, string>();
    if (listing.items.length > 0) {
      const rows = await drizzle(d1)
        .select({ repoId: repoSettings.repoId, description: repoSettings.description })
        .from(repoSettings)
        .where(inArray(repoSettings.repoId, listing.items.map((item) => item.repo.id)))
        .all();
      for (const row of rows) descriptions.set(row.repoId, row.description);
    }
    return {
      family,
      page,
      more: page * SOCIAL_PAGE_SIZE < listing.total,
      total: listing.total,
      forks: listing.items.map((item) => ({ ...item, description: descriptions.get(item.repo.id) ?? "" })),
      cards: [],
    };
  }
  const options = { page, pageSize: SOCIAL_PAGE_SIZE };
  const listing =
    family === "stars" ? await listRepoStargazers(d1, repo.id, options) : await listRepoSubscribers(d1, repo.id, options);
  return {
    family,
    page,
    more: page * SOCIAL_PAGE_SIZE < listing.total,
    total: listing.total,
    forks: [],
    cards: listing.items,
  };
}

// ---------------------------------------------------------------------------
// Components (user_cards.tmpl + the shared/repo/list row, reductions in the
// module header)
// ---------------------------------------------------------------------------

/** Upstream `User.DisplayNameWithFullName` (models/user/user.go:496-501). */
function displayNameWithFullName(user: UserRow): string {
  const fullName = (user.fullName ?? "").trim();
  return fullName === "" ? user.username : `${user.username} (${fullName})`;
}

/**
 * The card meta's website anchor: http(s) only — Go's html/template
 * neutralizes any other scheme at emit time (the ZgotmplZ arm), so a
 * non-http(s) website falls through to the next meta arm.
 */
function safeWebsiteHref(user: UserRow): string | null {
  const website = user.website ?? "";
  if (website === "" || !/^https?:\/\//i.test(website)) return null;
  return website;
}

/** One user_cards.tmpl `li.item.ui.segment` card (the header's avatar-slot
 *  and type-label reductions). */
export function UserCardRow(props: { user: UserRow }) {
  const { user } = props;
  const websiteHref = safeWebsiteHref(user);
  return (
    <li class="item ui segment">
      <span class="ui avatar" aria-hidden="true">
        <Icon name="octicon-person" size={48} />
      </span>
      <h3 class="name flex-text-block">
        <a href={userLink(user.username)}>{displayNameWithFullName(user)}</a>
      </h3>
      <div class="meta flex-text-block">
        {websiteHref !== null ? (
          <>
            <Icon name="octicon-link" />{" "}
            <a href={websiteHref} target="_blank">
              {user.website}
            </a>
          </>
        ) : user.location !== null && user.location !== "" ? (
          <>
            <Icon name="octicon-location" /> {user.location}
          </>
        ) : (
          <>
            <Icon name="octicon-calendar" /> {repoSocialLocale.joined_on} {formatDueDate(user.createdAt)}
          </>
        )}
      </div>
    </li>
  );
}

/** One shared/repo/list `.item` fork row with the owner-prefix title arm
 *  (upstream ShowRepoOwnerOnList — the header's why) and the landed trailing
 *  count reduction. */
export function ForkListItem(props: { item: RepoSocialFork }) {
  const { repo, owner, description } = props.item;
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const openPulls = Math.max(repo.numPulls - repo.numClosedPulls, 0);
  return (
    <div class="item">
      <div class="item-leading">
        <span class="ui avatar" aria-hidden="true">
          <Icon name="octicon-person" size={24} />
        </span>
      </div>
      <div class="item-main">
        <div class="item-header">
          <div class="item-title">
            <a class="tw-text-primary name" href={userLink(owner.username)}>
              {owner.username}
            </a>
            /
            <a class="tw-text-primary name" href={repoLink}>
              {repo.slug}
            </a>
            <span class="label-list">
              {repo.isArchived ? <span class="ui basic label">{repoSocialLocale.repo_archived}</span> : null}
              {repo.visibility === "private" ? (
                <span class="ui basic label">{repoSocialLocale.repo_private}</span>
              ) : owner.visibility === "private" ? (
                <span class="ui basic label">{repoSocialLocale.repo_internal}</span>
              ) : null}
            </span>
          </div>
          <div class="item-trailing muted-links">
            {/* The stars trailing count (list.tmpl:45-49 — rendered BEFORE
                the pulls mark) reads the maintained `repositories.num_stars`
                column (migration 0030), the same value the API serves as
                `stars_count`. The CountFmt (1000+) abbreviation is reduced
                to the raw number like the pulls count beside it. */}
            <a class="flex-text-inline" href={`${repoLink}/stars`}>
              <span class="tw-contents" aria-label={repoSocialLocale.stars_aria}>
                <Icon name="octicon-star" size={16} />
              </span>
              <span>{repo.numStars}</span>
            </a>
            <a class="flex-text-inline" href={`${repoLink}/pulls`}>
              <span class="tw-contents" aria-label={repoSocialLocale.pulls_aria}>
                <Icon name="octicon-git-pull-request" size={16} />
              </span>
              <span>{openPulls}</span>
            </a>
          </div>
        </div>
        {description !== "" ? <div class="item-body">{description}</div> : null}
        {repo.updatedAt !== null ? (
          <div class="item-body">
            {repoSocialLocale.repo_updated} <TimeSince unixSeconds={Math.floor(repo.updatedAt.getTime() / 1000)} tz="+0000" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module). */
export function renderRepoSocialPage(ctx: UiContext, data: RepoSocialData): string {
  return renderPage(<RepoSocialPage ctx={ctx} data={data} />);
}

/** The trio's page (§2.4.1 discriminators: `repository forks` and — for BOTH
 *  stars and watchers, tplWatchers serving upstream's Stars handler —
 *  `repository watchers`). */
export function RepoSocialPage(props: { ctx: UiContext; data: RepoSocialData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoSocialPage requires ctx.repo (BaseLayout renders it only when resolved)");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const title = repoSocialTitle(data.family);
  return (
    <BaseLayout
      ctx={ctx}
      title={title}
      pageClass={data.family === "forks" ? "repository forks" : "repository watchers"}
    >
      <div class="ui container">
        {data.family === "forks" ? (
          <div class="fork-list">
            <h2 class="ui dividing header">{title}</h2>
            {data.forks.length === 0 ? (
              <div>{repoSocialLocale.no_results}</div>
            ) : (
              <div class="flex-divided-list items-with-main">
                {data.forks.map((item) => (
                  <ForkListItem key={item.repo.id} item={item} />
                ))}
              </div>
            )}
            <OrgHomePagination orgLink={`${repoLink}/forks`} page={data.page} more={data.more} />
          </div>
        ) : (
          <div class="user-cards">
            <h2 class="ui dividing header">{title}</h2>
            <ul class="list">
              {data.cards.map((user) => (
                <UserCardRow key={user.id} user={user} />
              ))}
            </ul>
            <OrgHomePagination orgLink={`${repoLink}/${data.family}`} page={data.page} more={data.more} />
          </div>
        )}
      </div>
    </BaseLayout>
  );
}
