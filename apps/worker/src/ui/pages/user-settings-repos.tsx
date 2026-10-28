/**
 * The user settings REPOS tab — the LAST survey-(d) remainder (bench row
 * `wave-settings-repos`, MOUNTED at 484eb92 — the route lives in
 * `index.ts`): upstream
 * `templates/user/settings/repos.tmpl` at the pin, served by
 * `user_setting.Repos` (routers/web/user/setting/profile.go:222-325) behind
 * `m.Get("/repos", user_setting.Repos)` (web.go:734) inside the reqSignIn
 * `/user/settings` group (web.go:754 closes the group) — so the tab is
 * ALWAYS the doer's own list (`ctxUser := ctx.Doer`, profile.go:242; there
 * is no `{username}` scope on this surface).
 *
 * ## Brief-premise verification (verify-at-the-pin)
 *
 * The handler branches on `adoptOrDelete` (profile.go:240 — site admin, or
 * both unadopted-repo settings on): the ADMIN arm walks
 * `gitrepo.UserLocalPath(ctxUser.Name)` for on-disk `.git` directories
 * without a repositories row (the `.Dirs`/`.ReposMap` template data,
 * profile.go:245-301) and the template renders per-directory
 * adopt/delete buttons POSTing `/user/settings/repos/unadopted`
 * (web.go:735 → `AdoptOrDeleteRepository`, adopt.go:16-61). OUR POSTURE
 * (§2.4.1 degradation, rendered honestly):
 *
 *   - NO landed adoption service exists (grep: only the LFS `adopt` state
 *     machine and push-create's branch adoption — unrelated families), and
 *   - the branch is STRUCTURALLY empty here, not merely unimplemented: an
 *     "unadopted repository" is a git directory on local disk without a
 *     metadata row; our repositories live in R2/DO behind the D1 row
 *     (ADR-0001), so there is no on-disk namespace to walk and no such
 *     object can exist.
 *
 * So `allowAdopt`/`allowDelete` are false and the handler takes the
 * template's ELSE branch verbatim (profile.go:302-320): the plain
 * `.Repos` list — `GetUserRepositories(SearchRepoOptions{OwnerID:
 * ctxUser.ID, Private: true, ListOptions})` (profile.go:303) — plus the
 * pager. NO adopt/delete controls render, NO parse/apply POST exists in
 * this module, and upstream's POST route stays UNCLAIMED (the engine 404s
 * it — upstream's own answer for the slice at our posture).
 *
 * ## Data (§3.2 — the landed reads, never a self-fetch)
 *
 * The self-list WHERE is `loadUserProfileData`'s doer-visible self arm
 * (pages/user-profile.tsx:271-274 — `owner_id = user.id` with NO
 * visibility filter, `seePrivate` always true on this reqSignIn page;
 * upstream `Private: true`, profile.go:303). No landed service carries
 * the arm (the profile page sets the module-local direct-Drizzle
 * precedent this loader mirrors; the §Architecture D1 rule binds route
 * handlers, and the wiring handler only calls this loader). Deviations
 * from upstream, documented:
 *
 *   - Order: upstream GetUserRepositories defaults to `updated_unix DESC`
 *     (models/repo/repo_list.go:814-815); the landed `slug ASC` wins (the
 *     user-profile header's "the landed order wins" note, listOrgRepos
 *     parity).
 *   - Page size: upstream `setting.UI.Admin.UserPagingNum` = 50
 *     (modules/setting/ui.go:138, read at profile.go:230 — the SAME
 *     setting the organizations tab cites).
 *   - The only query param is `page` (`ctx.FormInt("page")`,
 *     profile.go:231) — no q/sort exists on this tab at the pin.
 *   - Forked-from: upstream `GetBaseRepo` per fork row (profile.go:310-317)
 *     batch-loads here (one `fork_parent` IN read + one parent-owner users
 *     IN read — the profile loader's batched-description pattern). A
 *     DANGLING edge (the parent row purged) renders the fork glyph without
 *     the forked-from line — upstream's GetBaseRepo-error ServerError arm
 *     is not reproducible and a dead link is forbidden; the parent owner's
 *     display-case username comes from its users row (org rows included —
 *     the users table carries both types), falling back to the case-folded
 *     namespace when the owner row is gone.
 *
 * ## DOM contract (repos.tmpl:80-113, the else branch, at the pin)
 *
 * layout_head's pageClass is the literal `user settings repos`
 * (repos.tmpl:1); the `.user-setting-content` wraps the `settings.repos`
 * header over the `.ui.attached.segment` carrying, inside the
 * `{{if .Repos}}` arm, the `.ui.list` of rows — each `.item >
 * .content.flex-text-block` with the kind icon, the `Owner/Name` link
 * (`.Link` = `/{OwnerName}/{Name}`), the `FormatByteSize .Size` span, and
 * the fork's `repo.forked_from` line — then `base/paginate` (the
 * Newer/Older pair, the organizations reduction). The `{{else}}` arm
 * renders the bare `settings.repos_none` item (NO `.ui.list` wrapper).
 * Icon selection order (repos.tmpl:86-96): private → `octicon-lock` 16
 * `tw-text-gold`; fork → `octicon-repo-forked`; mirror →
 * `octicon-mirror`; template → `octicon-repo-template`; else
 * `octicon-repo` — the chain is INDEPENDENT of the forked-from line
 * (repos.tmpl:99-102), so a private fork renders the lock AND the line.
 * Size bytes: `repositories.sizeKb` stores the settled KiB; upstream
 * FormatByteSize takes BYTES → `sizeKb * 1024` (the admin-repos rule).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The non-allowlisted glyphs ride the embedded-bytes seam:
 *   octicon-lock/mirror/repo-forked via admin-users.tsx's exported
 *   ADMIN_EMBEDDED_ICONS renderer (the sibling-page export), and
 *   octicon-repo-template — not in that map, the generator allowlist, or
 *   the shared Icon — embeds the pinned submodule's exact asset bytes
 *   module-locally (the pull-merge-box FOLD_SVG precedent).
 * - The adopt/delete modal family (repos.tmpl:7-72's branch) renders
 *   NOTHING — the degradation posture above; the
 *   octicon-file-directory-fill dir glyph belongs to that branch and is
 *   absent here.
 * - The nav is the SHARED components/settings-nav `UserSettingsNavbar`
 *   with `active: "repos"` (the Repos item appended after Organizations,
 *   upstream navbar.tmpl:73-76 — the template's LAST item; the mount
 *   window's swap — the module-local scaffolding copy was deleted).
 *
 * ## Mount record (MOUNTED at 484eb92 — the wiring HANDOFF is retired)
 *
 * All three diffs landed as written: (1) `index.ts` claims the exact
 * `/user/settings/repos` tail inside the /user/settings block, after the
 * organization claims (template order, static-before-dynamic — GET ONLY;
 * upstream's POST /user/settings/repos/unadopted, web.go:735 → adopt.go,
 * stays UNCLAIMED per the degradation posture), the handler registers
 * beside its organizations twin, and this module's
 * exports join the import block. (2) The shared components/settings-nav
 * gained the `repos` locale key + the `UserSettingsNavTab` `"repos"` item
 * after Organizations (navbar.tmpl:73-76), this module's local
 * `UserSettingsReposNav` scaffolding copy was DELETED, and the page's call
 * site swapped to `UserSettingsNavbar active="repos"` (swap-list entry 14).
 * (3) The route test matrix rides the mounted GET. Survey row flipped on
 * landing: docs/compat/ui-parity-survey.md:546 (the
 * `/user/settings/{…,repos}` PARTIAL row — repos moved out of the
 * STILL-ABSENT enumeration).
 */

import { asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../../db/schema";
import { AdminEmbeddedSvg } from "./admin-users";
import { formatByteSize, parsePageNumber } from "../page-data";
import { UserSettingsNavbar } from "../components/settings-nav";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsReposLocale = {
  repos: "Repositories", // "settings.repos" (the Title, the header, the nav item's text — locale_en-US:649)
  repos_none: "You do not own any repositories.", // "settings.repos_none" (locale_en-US:924)
  forked_from: "forked from", // "repo.forked_from" (locale_en-US:1148)
} as const;

/** Upstream `setting.UI.Admin.UserPagingNum` (modules/setting/ui.go:138,
 *  read at profile.go:230) — the page's list ceiling (the organizations
 *  tab's same setting). */
export const USER_SETTINGS_REPOS_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// The page data (upstream Repos' else-branch template data over the landed
// columns)
// ---------------------------------------------------------------------------

/** The forked-from line's resolved parent (upstream `.BaseRepo` —
 *  repos.tmpl:99-102). `href` is the case-folded lookup key
 *  `/{ownerNamespace}/{slug}`; the display name is the parent owner's
 *  users-row username when that row survives. */
export interface UserSettingsReposForkedFrom {
  ownerName: string;
  name: string;
  href: string;
}

/** One `.Repos` row's render inputs (repos.tmpl:83-105's else-branch
 *  shape over the landed columns). */
export interface UserSettingsReposItem {
  id: string;
  /** `/{ownerNamespace}/{slug}` — upstream `.Link` (the case-folded
   *  lookup key, the admin-repos href rule). */
  href: string;
  /** The owner's DISPLAY-case name — upstream `.OwnerName`; every row's
   *  owner IS the doer on this always-self page. */
  ownerName: string;
  /** `repositories.slug` — upstream `.Name`. */
  name: string;
  /** `FormatByteSize(Size)` — the settled KiB column times 1024 (the
   *  admin-repos byte rule). */
  sizeText: string;
  isPrivate: boolean;
  /** `forkParent !== null` — upstream `.IsFork` (the admin-repos rule). */
  isFork: boolean;
  isMirror: boolean;
  isTemplate: boolean;
  /** The resolved parent; null when the edge dangles (the module header's
   *  data note) or the repo is no fork. */
  forkedFrom: UserSettingsReposForkedFrom | null;
}

/** The tab's render inputs: the doer's display name (every row's
 *  `.OwnerName`), one page of owned rows, the pager state. */
export interface UserSettingsReposPageData {
  ownerName: string;
  repos: UserSettingsReposItem[];
  page: number;
  more: boolean;
}

/**
 * Load the page (§3.2 — the landed self-list read, the user-profile
 * loader's self arm at this page's own `?page=`): `owner_id = userId` with
 * NO visibility filter (the reqSignIn page is always self — upstream
 * `Private: true`, profile.go:303), ordered `slug ASC` (the landed order —
 * the module header's deviation note), paged at 50. The doer's users row
 * gates the load (null = the session doer has no D1 row — the
 * silent-auth-failure 404 input, the notifications-loader slice); the fork
 * parents + their owners batch-load behind it.
 */
export async function loadUserSettingsReposPageData(d1: D1Database, userId: number, params: URLSearchParams): Promise<UserSettingsReposPageData | null> {
  const db = drizzle(d1);
  const owner = await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get();
  if (owner === undefined) return null;
  const page = parsePageNumber(params.get("page"));
  const where = eq(repositories.ownerId, userId);
  const rows = await db
    .select()
    .from(repositories)
    .where(where)
    .orderBy(asc(repositories.slug))
    .limit(USER_SETTINGS_REPOS_PAGE_SIZE)
    .offset((page - 1) * USER_SETTINGS_REPOS_PAGE_SIZE);
  const totalRow = await db.select({ total: sql<number>`count(*)` }).from(repositories).where(where).get();
  const total = Number(totalRow?.total ?? 0);

  // The forked-from projection: one batched parent read + one batched
  // parent-owner read (the profile loader's batched-description pattern).
  const parentIds = [...new Set(rows.map((row) => row.forkParent).filter((id): id is string => id !== null))];
  const parents = new Map<string, { ownerNamespace: string; ownerId: number | null; slug: string }>();
  if (parentIds.length > 0) {
    const parentRows = await db
      .select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, ownerId: repositories.ownerId, slug: repositories.slug })
      .from(repositories)
      .where(inArray(repositories.id, parentIds))
      .all();
    for (const row of parentRows) parents.set(row.id, row);
  }
  const parentOwnerNames = new Map<number, string>();
  const parentOwnerIds = [...new Set([...parents.values()].map((parent) => parent.ownerId).filter((id): id is number => id !== null))];
  if (parentOwnerIds.length > 0) {
    const ownerRows = await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, parentOwnerIds)).all();
    for (const row of ownerRows) parentOwnerNames.set(row.id, row.username);
  }

  return {
    ownerName: owner.username,
    page,
    more: page * USER_SETTINGS_REPOS_PAGE_SIZE < total,
    repos: rows.map((row) => {
      const parent = row.forkParent !== null ? parents.get(row.forkParent) : undefined;
      const forkedFrom: UserSettingsReposForkedFrom | null =
        parent === undefined
          ? null
          : {
              ownerName: (parent.ownerId !== null ? parentOwnerNames.get(parent.ownerId) : undefined) ?? parent.ownerNamespace,
              name: parent.slug,
              href: `/${parent.ownerNamespace}/${parent.slug}`,
            };
      return {
        id: row.id,
        href: `/${row.ownerNamespace}/${row.slug}`,
        ownerName: owner.username,
        name: row.slug,
        sizeText: formatByteSize(row.sizeKb * 1024),
        isPrivate: row.visibility === "private",
        isFork: row.forkParent !== null,
        isMirror: row.isMirror,
        isTemplate: row.isTemplate,
        forkedFrom,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The render (repos.tmpl:80-113, the else branch, at the pin)
// ---------------------------------------------------------------------------

/** `octicon-repo-template`'s exact `<path d>` bytes — the pinned submodule's
 *  gitea/public/assets/img/svg/octicon-repo-template.svg (the FOLD_SVG
 *  precedent): the icon is in neither the generator allowlist nor
 *  admin-users.tsx's embedded map, and neither file is this wave's. */
const REPO_TEMPLATE_ICON_PATH =
  "M13.25 8a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-.75a.75.75 0 0 1 0-1.5h.75v-.25a.75.75 0 0 1 .75-.75M5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2ZM2.75 8a.75.75 0 0 1 .75.75v.268Q3.624 9 3.75 9h.5a.75.75 0 0 1 0 1.5h-.5a.25.25 0 0 0-.25.25v.75c0 .28.114.532.3.714a.75.75 0 1 1-1.05 1.072A2.5 2.5 0 0 1 2 11.5V8.75A.75.75 0 0 1 2.75 8M11 .75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V1.5h-.75A.75.75 0 0 1 11 .75m-5 0A.75.75 0 0 1 6.75 0h2.5a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 6 .75m0 9A.75.75 0 0 1 6.75 9h2.5a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 6 9.75M4.992.662a.75.75 0 0 1-.636.848c-.436.063-.783.41-.846.846a.751.751 0 0 1-1.485-.212A2.5 2.5 0 0 1 4.144.025a.75.75 0 0 1 .848.637M2.75 4a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 2.75 4m10.5 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75";

/** The row's kind icon — repos.tmpl:86-96's chain, verbatim order:
 *  private → lock(gold); fork → repo-forked; mirror → mirror; template →
 *  repo-template; else repo. The lock/mirror/fork bytes ride
 *  admin-users.tsx's embedded seam; repo-template renders its own bytes
 *  (the same DOM shape); repo is allowlisted on the shared Icon. */
function RepoKindIcon(props: { item: UserSettingsReposItem }) {
  const { item } = props;
  if (item.isPrivate) return <AdminEmbeddedSvg name="octicon-lock" class="tw-text-gold" />;
  if (item.isFork) return <AdminEmbeddedSvg name="octicon-repo-forked" />;
  if (item.isMirror) return <AdminEmbeddedSvg name="octicon-mirror" />;
  if (item.isTemplate) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width={16} height={16} class="svg octicon-repo-template" aria-hidden="true">
        <path d={REPO_TEMPLATE_ICON_PATH} />
      </svg>
    );
  }
  return <Icon name="octicon-repo" />;
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderUserSettingsReposPage(ctx: UiContext, data: UserSettingsReposPageData): string {
  return renderPage(<UserSettingsReposPage ctx={ctx} data={data} />);
}

/**
 * The repos settings page (§2.4.1 discriminator: the literal
 * `user settings repos` — layout_head's pageClass dict, repos.tmpl:1).
 */
export function UserSettingsReposPage(props: { ctx: UiContext; data: UserSettingsReposPageData }) {
  const { ctx, data } = props;
  if (ctx.viewer.kind !== "user") throw new Error("UserSettingsReposPage requires a signed-in viewer");
  const basePath = "/user/settings/repos";
  const pageHref = (target: number): string => `${basePath}?page=${target}`;
  return (
    <BaseLayout ctx={ctx} title={userSettingsReposLocale.repos} pageClass="user settings repos">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="repos" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {/* repos.tmpl:3-5 — the header. */}
            <h4 class="ui top attached header">{userSettingsReposLocale.repos}</h4>
            <div class="ui attached segment">
              {/* The adopt/delete branch (repos.tmpl:7-72) renders NOTHING —
                  the degradation posture (the module header). */}
              {data.repos.length === 0 ? (
                /* repos.tmpl:108-112 — the bare repos_none item, no list wrapper. */
                <div class="item">{userSettingsReposLocale.repos_none}</div>
              ) : (
                <>
                  {/* repos.tmpl:82-106 — the list + rows. */}
                  <div class="ui list">
                    {data.repos.map((item) => (
                      <div class="item">
                        <div class="content flex-text-block">
                          <RepoKindIcon item={item} />
                          <a class="name" href={item.href}>
                            {item.ownerName}/{item.name}
                          </a>
                          <span>{item.sizeText}</span>
                          {/* repos.tmpl:99-102 — independent of the icon
                              chain: a private fork renders the lock AND
                              this line; a dangling edge renders neither
                              glyph-swap nor line. */}
                          {item.isFork && item.forkedFrom !== null ? (
                            <>
                              {userSettingsReposLocale.forked_from}
                              <span>
                                <a href={item.forkedFrom.href}>
                                  {item.forkedFrom.ownerName}/{item.forkedFrom.name}
                                </a>
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* base/paginate (repos.tmpl:107) — the Newer/Older pair,
                      the organizations reduction; upstream's page hrefs
                      carry the bare ?page= form. */}
                  {data.page > 1 || data.more ? (
                    <div class="center page buttons">
                      <div class="ui borderless pagination menu">
                        {data.page > 1 ? (
                          <a class="item navigation" href={pageHref(data.page - 1)}>
                            <span class="navigation_label">Newer</span>
                          </a>
                        ) : null}
                        {data.more ? (
                          <a class="item navigation" href={pageHref(data.page + 1)}>
                            <span class="navigation_label">Older</span>
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
