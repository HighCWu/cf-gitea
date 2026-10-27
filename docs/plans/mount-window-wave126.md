# Mount Window — wave-126 (de-risk plan)

Basis: HEAD `ed45502` (2026-10-27); `apps/worker/src/ui/index.ts` last touched by `b1bf73a`
(the activity-tab mount). Every recipe below was re-verified against THAT state by reading the
current file — line numbers in this document are the CURRENT ones, not the handoffs' citations.
The window mounts ~12 committed-unmounted modules in ONE index.ts pass; this plan exists so
that pass never has to re-derive an anchor mid-flight.

Verification method: each module's HANDOFF NOTE was read, then every cited insertion point was
re-read at HEAD. Result up front: **no blockers, no collisions**; four stale-anchor notes and
two recipe gaps to close inside the window (§5). One mission-list correction: milestone-detail
is ALREADY MOUNTED (§5.1).

---

## 0. The current-state anchor map (verified quotes)

| Anchor | Current location | Current shape (quoted) |
| --- | --- | --- |
| `ParsedUiRoute` union tail | index.ts:2386 | `\| ReleaseDownloadRoute ... \| LastCommitRoute \| BlobExcerptRoute;` — every new interface joins here, after `BlobExcerptRoute` |
| `ReleaseDownloadRoute` | index.ts:1555 | the releases twin recipes' "beside" anchor |
| `WikiRoute` | index.ts:2059 | the wiki-raw recipe's "beside" anchor |
| `IssueAuxRoute` union | index.ts:2147-2171 | `family: "issues-search-aux" \| ... \| "issue-content-overview" \| "issue-attachments-alias" \| ...` |
| `UserSettingsTabRoute` union | index.ts:2199-2222 | ends `... \| "user-settings-organizations" \| "user-settings-organizations-leave";` with `id: number \| null` |
| `AdminRoute` union | index.ts:2187-2192 | `family: "admin-dashboard" \| "admin-monitor"; page?: "stats" \| "cron" \| "queue" \| "trace"` |
| Early wiki block | index.ts:2919-2933 | `if (head === "wiki") { if (rest.length === 2 && rest[0] === "blob_excerpt") {...} }` — ONLY the excerpt arm inside |
| Wiki page catch-all | index.ts:3165-3177 | `if (head === "wiki") { ... return { family: "wiki", owner, repo, rawTail }; }` — comment at :3169 still says "The raw/* byte arm stays unclaimed" |
| Issues/pulls 3-segment arm | index.ts:2980-3004 | `if (rest.length === 3 && /^-?\d+$/.test(rest[0]))` — overview claim at :2984-2986, comment :2982-2983 says "list/detail stay unclaimed — no snapshot store" |
| `head === "releases"` block | index.ts:3254-3311 | ends `return null` at :3310 |
| `head === "tags"` block | index.ts:3370-3375 | ends `return null` at :3374 |
| User-settings literal block | index.ts:2468-2525 | `if (raw[1] === "user" && raw[2] === "settings")` — tail claims through `organization/leave`, then `return null` at :2524 |
| Admin literal block | index.ts:2562-2572 | `if (raw[1] === "-" && raw[2] === "admin")` — dashboard + four monitor pages, `return null` at :2571 |
| ownerHomePage USER half | index.ts:5097-5133 | `resolveUiSession` (NO repo); doer at :5102 `{ id, isAdmin }`; `profile.kind === "missing"` 404 at :5121; `tab=activity` arm :5127-5130; default `loadUserProfileData` fall-through :5131-5132 |
| `userSettingsTabPrologue` | index.ts:5249-5261 | guard-first optional, session, anonymous login-303; GETs call `(c, false)`, POSTs `(c, true)` |
| Settings handlers (secrets pair) | index.ts:5299-5327 | the GET/POST/delete trio shape the window's two settings tabs mirror |
| `adminPagePrologue` | index.ts:6247-6256 | session → anonymous login-303 → non-admin 404 shell |
| `releaseDownloadTail` | index.ts:7523-7549 | resolveUiRequest → drift guard → `releasesReadGate` :7530 |
| `blobExcerptFragment` | index.ts:7624-… | the wiki twin's `hasWiki` gate at :7632-7635 (MustEnableWiki 404) |
| `releasesReadGate` | index.ts:7878-7881 | `if (repo.isEmpty) return false; return (await loadRepoSettings(db, repo.id)).hasReleases;` |
| `issueContentOverviewRoute` | index.ts:4554-4566 | resolveUiRequest → drift guard → `resolveFragmentIssue` → loader → Response builder |
| Aux registrations | index.ts:9733-9739 | `:kind{issues|pulls}` + `:index{\\d+}` constrained params; content-history/overview at :9736 |
| User-feed registration (dotted-tail convention) | index.ts:9731 | `uiRouter.get("/:owner{^[\\w-]+\\.(rss|atom)$}", (c) => userFeedRoute(c));` — the recipes cite "9716-9717" |
| Settings registrations | index.ts:9515-9542 | the `/user/settings/*` literal block |
| Admin registrations | index.ts:9620-9626 | the `/-/admin*` literal block |
| Excerpt + wiki + lastcommit registrations | index.ts:10075-10083 | excerpt twins :10075-10076; wiki family :10079-10082 (`wiki` then `wiki/*`); lastcommit :10083 (physical EOF) |
| `handlesUiRoute` | index.ts:3567-3569 | `return parseUiRoute(pathname) !== null;` — a NEW parse claim IS the dispatcher consult; no second table exists |

---

## 1. Module-by-module mount recipes (verified)

Each subsection: what the handoff says, what HEAD says, the exact window operation. All
handler arms follow the two landed prologues — repo-scoped byte/page arms use
`resolveUiRequest`; session-only surfaces use `resolveUiSession`/`userSettingsTabPrologue`/
`adminPagePrologue`. Every new handler carries the `route.family !== "…"` drift guard.

### 1.1 releases-feed-xml.ts (2 families, 4 ops)

Handoff verified against HEAD — all four anchors hold:

1. `ReleasesFeedRoute` interface (`family: "release-feed-rss" | "release-feed-atom";
   owner; repo`) beside `ReleaseDownloadRoute` (:1555); both families join `ParsedUiRoute`
   at :2386.
2. Parse claim as its own head-literal block BESIDE `head === "releases"` (:3254) — the
   claim is `tail.length === 1 && (head === "releases.rss" || head === "releases.atom")`,
   returning by the head's exact value. Disjoint literals from the `head === "releases"`
   block, so order between them is irrelevant; nothing earlier claims a dotted head (the
   only dotted-tail claim today is pull-diffpatch under the `pulls` head). Case-sensitively
   exact: `releases.RSS` and a ref named `releases.rss` stay unclaimed → engine 404.
3. Registration `uiRouter.get("/:owner/:repo/:segment{^releases\\.(rss|atom)$}", (c) =>
   releasesFeedRoute(c));` — the user-feed one-constrained-registration convention
   (:9731). No existing 3-segment pattern matches a `releases.rss` second segment.
4. Handler beside `releaseDownloadTail` (:7523): `resolveUiRequest` → drift guard →
   `releasesReadGate(c.env.DB, repo)` (:7878 — MustBeNotEmpty + releases-unit verbatim) →
   `loadReleasesFeedData(c.env.DB, repo, url.origin)` (signature verified at
   releases-feed-xml.ts:412; null → 404 shell) → `renderReleasesFeedRss`/`...Atom` by
   family → `new Response(body, { headers: { "content-type":
   RELEASES_FEED_CONTENT_TYPES.rss/.atom } })` (alias of `USER_FEED_CONTENT_TYPES`,
   verified :280). NO EnableFeed arm (pin default TRUE), NO viewer parameter (drafts
   excluded unconditionally upstream).

### 1.2 tags-feed-xml.ts (2 families, 4 ops)

Handoff verified; the gates DIFFER from the releases twin and the handler must honor that:

1. `TagsFeedRoute` (`family: "tags-feed-rss" | "tags-feed-atom"`) beside the releases
   twin's new interface; both families join the union at :2386.
2. Parse claim beside `head === "tags"` (:3370): `tail.length === 1 && (head ===
   "tags.rss" || head === "tags.atom")`. Disjoint literal — no collision with the tags
   block; a test pinning the inert posture EXISTS and must flip (§4, pages-wave25:240).
3. Registration `uiRouter.get("/:owner/:repo/:segment{^tags\\.(rss|atom)$}", (c) =>
   tagsFeedRoute(c));`.
4. Handler beside the releases feed handler: `resolveUiRequest` → drift guard → **NO
   `releasesReadGate`** (web.go:1502 gates reqUnitCodeReader, not the releases reader —
   the §2.5 prologue IS that pair here) → `loadTagsFeedData(c.env, c.env.DB, repo,
   url.origin)` (signature verified at tags-feed-xml.ts:473 — takes `env` FIRST; its only
   null arm is the empty repo = MustBeNotEmpty) → render by family with
   `TAGS_FEED_CONTENT_TYPES` (:334).

**Order constraint between the twins: none** — four disjoint head literals. Mounting them
in either order is safe; the only shared edit surface is the union tail at :2386 (fold both
interfaces in one edit).

### 1.3 wiki-raw.ts (1 family, 3 ops)

Handoff verified — the ordering constraint it warns about is REAL and load-bearing:

1. `WikiRawRoute` (`family: "wiki-raw"; owner; repo; rawTail`) beside `WikiRoute` (:2059);
   joins the union after `BlobExcerptRoute` (:2386, the recipe's exact predicted tail).
2. Parse claim INSIDE the early `head === "wiki"` block (:2919-2933), after the
   blob_excerpt arm: `if (rest.length >= 2 && rest[0] === "raw")` → per-segment
   `decodeURIComponent` + `"/"` join (decode throw → `null`). **MUST** live here: the
   `family: "wiki"` catch-all at :3165-3177 currently swallows every wiki tail (its
   comment at :3169 even documents the raw arm as unclaimed — update that comment in the
   same window). The bare `/wiki/raw` (`rest.length === 1`) falls through to the page
   family, exactly chi's wildcard-miss; the wiki page family answers it as the
   reserved-name miss (303 `?action=_pages`) — that behavior for the BARE tail is
   upstream parity and stays.
3. Handler + registration: `wikiRawBlob` beside `blobExcerptFragment` (:7624) —
   `resolveUiRequest` (the wiki-reader visibility arm) → drift guard →
   `loadRepoSettings` + `!settings.hasWiki` → 404 shell (MustEnableWiki, the excerpt
   twin's :7632-7635 arm verbatim) → `findRepositoryById` re-read (the wikiPrologue
   precedent) → `loadWikiRawBlob(c.env, pair, route.rawTail)` (re-export verified at
   wiki-raw.ts tail) → null → 404 shell → `wikiRawBlobResponse(blob, { cacheIsPublic,
   ifNoneMatch })`. Registration `uiRouter.get("/:owner/:repo/wiki/raw/*", (c) =>
   wikiRawBlob(c));` placed between the excerpt lines (:10075-10076) and the wiki family
   (:10079-10080) — **specific-before-wildcard: `wiki/raw/*` MUST precede `wiki/*` or hono's
   first-match hands every raw tail to `wikiPage` and the family is dead** (the a58cad5
   dead-wiki class). Plain `{repo}` param (no `[^-].*` constraint — the :10068-10074 rule).

### 1.4 user-follow-tabs.tsx (1 dispatch arm, 1 strip fold, 1 avatar-card diff)

1. Dispatch arm in ownerHomePage (:5127-5130 pattern), AFTER the activity arm, BEFORE the
   :5131 fall-through:
   `if (url.searchParams.get("tab") === "followers" || url.searchParams.get("tab") ===
   "following")` → `loadUserFollowTabsData(c.env.DB, profile.user, doer,
   url.searchParams)` → `respond(c.html(renderUserFollowTabsPage(ctx, data), 200))`.
   Verified: `doer` is ownerHomePage's existing `{ id, isAdmin }` (:5102); org names never
   reach the arm (org half answers at :5111).
2. Module-local strip: NO diff (its OverviewTabs renders both family tabs INACTIVE —
   correct header.tmpl behavior for `TabName = followers/following`).
3. The avatar-card anchor diff (user-profile.tsx `ProfileAvatarCard` :339): upstream
   `profile_big_avatar.tmpl:25` renders the counts as
   `<a href="{{.ContextUser.HomeLink}}?tab=followers">{{svg "octicon-person" 18
   "tw-mr-1"}}{{.NumFollowers}} {{Tr "user.followers"}}</a> · <a
   href="…?tab=following">{{.NumFollowing}} …</a>`. The window wraps the two landed
   plain-text `<span>`s (:357-367) in the two `/{username}?tab=followers|following`
   anchors. Recommend the parity-exact markup INCLUDING the 18px `octicon-person` glyph
   inside the followers anchor (octicon-person is allowlisted — it already renders in the
   avatar slot); the minimal wrap without the glyph also satisfies the recipe. The
   upstream `EnableFeed` `.rss` anchor after the counts stays unrendered (the landed
   reduction never rendered it; scope-creep to add it here).
4. Import line beside the activity module's imports in index.ts.

### 1.5 user-stars-tab.tsx (1 dispatch arm + the Stars strip fold)

1. Dispatch arm beside the activity arm (order vs follow/watching arms irrelevant —
   disjoint query literals): `if (url.searchParams.get("tab") === "stars")` →
   `loadUserStarsTabData(c.env.DB, profile.user, doer, url.searchParams)` →
   `renderUserStarsTabPage(ctx, data)` at 200.
2. **The Stars strip fold** (the semantic the window must not get wrong):
   `user/overview/header.tmpl:36-44` renders the Stars item inside the
   `{{if not .ContextUser.IsIndividual}}…{{end}}`'s IsIndividual block, gated
   `{{if not .DisableStars}}` — DisableStars defaults FALSE at the pin, so **Stars is the
   DEFAULT anchor and ships ACTIVE-capable in every strip**; the watching item is the
   `{{else}}` arm (§1.6) and does NOT render by default. Concretely:
   - user-profile.tsx `ProfileTabs` (:404): after the Activity anchor, add
     `<a class="item" href={`/${props.username}?tab=stars`}><Icon name="octicon-star" />
     {stars label}{starsCount > 0 ? <div class="ui small label">{starsCount}</div> :
     null}</a>`; props grow `starsCount` fed from `data.user.numStars` (the maintained
     `users.num_stars` column, migration 0031 — upstream's `{{if
     .ContextUser.NumStars}}` gate); `userProfileLocale` (:105) gains
     `starred: "Starred Repositories"`. The repositories tab stays the ACTIVE item here.
   - activity-feeds.tsx `OverviewTabs` (:741): same anchor (inactive), label via
     `activityFeedsLocale` gaining the key (or reuse `userProfileLocale.starred` — the
     module already imports from user-profile? it does NOT; keep its own locale object's
     new key).
   - user-follow-tabs.tsx `OverviewTabs` (:340): same anchor; this module DOES import
     `userProfileLocale` — reuse the new `starred` key.
   - octicon-star is allowlisted (the org-home star chips render it).
3. The stars page's own strip (module-local, Stars ACTIVE) ships with the module — no
   window diff.

### 1.6 user-watching-tab.tsx (1 dispatch arm + the watching strip fold)

1. Dispatch arm beside the activity arm: `if (url.searchParams.get("tab") ===
   "watching")` → `loadUserWatchingTabData(c.env.DB, profile.user, doer,
   url.searchParams)` → `renderUserWatchingTabPage(ctx, data)` at 200.
2. **Semantic guard (the wrong-default trap)**: watching is upstream's `{{else}}` arm of
   `{{if not .DisableStars}}` (header.tmpl:43-46 verified) — it REPLACES Stars when the
   setting is on and by default is reachable by DIRECT URL ONLY, with NOTHING active in
   the header. The landed strips cannot model a setting that does not exist, so the three
   strips show BOTH anchors and the in-code comment documents the collapsed-if. Place the
   watching anchor AFTER the Stars anchor (the pragmatic order both tab modules'
   handoffs agree on). Each diff adds ONE inactive item:
   `<a class="item" href={`/${props.username}?tab=watching`}><EyeIcon /> {watched
   label}</a>` — NO count label (upstream has none). Into ProfileTabs, activity-feeds'
   OverviewTabs, and follow-tabs' OverviewTabs; labels: `userProfileLocale.watched` /
   `activityFeedsLocale.watched` = "Watched Repositories" ("user.watched").
3. The eye glyph is NOT allowlisted: import `EyeIcon` from pages/user-watching-tab (the
   FOLD_SVG embed). Optional tooling op: `ALLOWLIST` += `'octicon-eye',` in
   scripts/gen-ui-icons.mjs → `pnpm gen:icons` → swap the embeds for `<Icon
   name="octicon-eye">`. Defer-able; the embed is faithful either way.
4. The watching page renders its own strip with the watching item ACTIVE — in-module.

### 1.7 user-settings-account.tsx (4 families, 8 ops)

The handoff specifies the arms but NOT the family literals — the window decides them
(recommended, matching the family's `<tab>` / `<tab>-<write>` convention):

- `"user-settings-account"` (GET), `"user-settings-account-email"` (POST …/email),
  `"user-settings-account-email-delete"` (POST …/email/delete),
  `"user-settings-account-delete"` (POST …/delete). All `id: null`.

1. Union: the four literals join `UserSettingsTabRoute` (:2199-2222).
2. Parse claims inside the `raw[1] === "user" && raw[2] === "settings"` block (:2468-2525),
   beside the keys/applications pairs: `account` (tail.length 1), `account/email`,
   `account/email/delete`, `account/delete` (tail.length 2 each, second segment the
   literal). No collision — `account` is unclaimed today (wave12 test pins it null, §4).
3. Handlers beside the secrets trio (:5299-5327), the handoff's arm map VERIFIED against
   the landed prologue pair:
   - GET → `userSettingsTabPrologue(c, false)` →
     `loadUserSettingsAccountPageData(c.env.DB, p.viewer.id)` (verified :272 — returns the
     doer's users ROW or null) → null 404-shells → `renderUserSettingsAccountPage(p.ctx,
     data)` (signature :619 — `(ctx, data, error = null, email = "")`; the invalid
     re-renders pass the carried email, never the password).
   - POST `…/email` → prologue `(c, true)` → `readUrlEncodedForm` →
     `parseUserSettingsAccountEmailForm` (:305) → `applyUserSettingsAccountEmailForm`
     (:378): "added"/"primary"/"redirect" → 303 onto `/user/settings/account`; "invalid" →
     reload + re-render 200 `{ error, email: form.email }`.
   - POST `…/email/delete` → prologue `(c, true)` →
     `parseUserSettingsAccountEmailDeleteForm` (:450) → `deleteUserSettingsAccountEmail`
     (:464, "deleted" | "missing") — BOTH outcomes 303 back (idempotent silent-303).
   - POST `…/delete` → prologue `(c, true)` → `parseUserSettingsAccountDeleteForm` (:489)
     → `applyUserSettingsAccountDeleteForm` (:502): "deleted" → 303 onto `/`; "invalid" →
     reload + re-render 200, password field EMPTY.
   The loader needs the users row itself (not just `viewer.id`) — the GET handler's null
   arm covers the vanished-row case exactly like the prologue family's convention.
4. Registrations beside the settings block (:9515-9542): GET `/user/settings/account` +
   the three POSTs.

### 1.8 user-settings-notifications.tsx (3 families, 6 ops)

Handoff's literals are explicit — use them verbatim:
`"user-settings-notifications"` / `"user-settings-notifications-email"` /
`"user-settings-notifications-actions"`, all `id: null`.

1. Union: the three literals join `UserSettingsTabRoute`.
2. Parse claims in the same settings block, beside account's:
   `notifications` (length 1), `notifications/email`, `notifications/actions` (length 2).
3. Handlers beside the secrets trio, the appearance handlers' exact shape (verified
   :5263-5290):
   - GET → prologue `(c, false)` → `loadUserSettingsNotificationsPageData(c.env.DB,
     p.viewer.id)` (:218, null → 404 shell) → `renderUserSettingsNotificationsPage(p.ctx,
     data)` (:356, third param `error` for the invalid re-render).
   - POST `…/email` → prologue `(c, true)` →
     `parseUserSettingsNotificationsEmailForm` (:241) →
     `applyUserSettingsNotificationsEmailForm` (:262): "saved" → 303 onto
     `/user/settings/notifications`; "invalid" → full-page re-render 200 with the
     per-form error (`{ form: "email", message }`).
   - POST `…/actions` → same prologue + `parseUserSettingsNotificationsActionsForm`
     (:247) + `applyUserSettingsNotificationsActionsForm` (:279), error routed as
     `{ form: "actions", message }`.
   - NO EnableNotifyMail / Actions-enabled 404 arms (both reduce to always-mounted, SPEC
     §3).
4. Registrations beside the settings block.

### 1.9 issue-content-fragments.ts — the list/detail arms (2 families, 4 ops)

(milestone-detail is NOT in this window — already mounted, §5.1. SPEC
specs/issue-content-history.md §6 verified against HEAD; its line cites drifted
(2976-2982 → 2980-3004, 4550-4560 → 4554-4566) but every shape holds. One wording
correction: §6 says `loadContentHistoryDetailFragment(db, …)` — the export takes
`env` FIRST (issue-content-fragments.ts:699: `env, repo, issue, viewer, commentId,
historyId`), as the module's own handoff states. Use `c.env`.)

1. `IssueAuxRoute` family union (:2147-2171) gains
   `"issue-content-history-list" | "issue-content-history-detail"` (both ride the
   interface's existing `index`/`urlKind` fields; no new fields needed — the query params
   stay OUT of the route).
2. Parse claims inside the `rest.length === 3` arm (:2980-3004), beside the overview claim
   (:2984-2986): `rest[1] === "content-history" && rest[2] === "list"` /
   `… && rest[2] === "detail"` → the families with `urlKind: head, index`. The arm's
   numeric guard is `-?\d+` and the registration's is `\d+` — KEEP that asymmetry (the
   info/overview precedent; aux-fragments.matrix pins the plain-404 answer for
   `/issues/-1/...`, so the mounted pattern must stay `\d+`).
3. Handlers beside `issueContentOverviewRoute` (:4554-4566), its exact shape:
   `resolveUiRequest` → drift guard (`family` + `route.index !== undefined`) →
   `resolveFragmentIssue(c.env.DB, repo, route.index)` (null → 404 shell) →
   - list: `commentId` = FormInt64 of the `comment_id` query param (parseInt, NaN → 0) →
     `loadContentHistoryListFragment(c.env.DB, issue, commentId)` (:594) →
     `contentHistoryListFragmentResponse(data)` (:636).
   - detail: `commentId` as above + `history_id` (same FormInt64) →
     `loadContentHistoryDetailFragment(c.env, repo, issue, viewer, commentId, historyId)`
     (:699 — viewer comes from the resolved prologue) →
     `contentHistoryDetailFragmentResponse(data)` (:753). **The `"notFound"` outcome IS
     the JSON 404 body — do NOT substitute the HTML shell** (the module handoff's loud
     rule; the empty-200 comment-miss quirk rides inside the loader's ok arm).
4. Registrations beside :9736, the same constrained-param form:
   `uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/content-history/list",
   …)` and `…/content-history/detail`.

### 1.10 admin-users.tsx / admin-orgs.tsx / admin-repos.tsx (3 families, 6 ops)

The shared recipe (admin-users.tsx's HANDOFF) verified against HEAD — the admin literal
block (:2562-2572) is exactly as cited:

1. `AdminRoute.family` union (:2187-2192) gains `"admin-users" | "admin-orgs" |
   "admin-repos"` (`page` stays absent on the three).
2. Parse claims INSIDE the admin block, BEFORE the block's `return null` and formatted as
   the recipe's static literals:
   - `if (tail.length === 1 && tail[0] === "users") return { family: "admin-users" };`
   - same for `"orgs"` and `"repos"`.
   Static-before-dynamic: these literals must precede ANY future `/-/admin/users/{id}`
   numeric arm (none exists today; the block's tail-length guards keep them unambiguous).
   The block itself already sits ahead of the owner/repo parse.
3. Handlers beside the admin pages (:6258-6310), `adminPagePrologue` (:6247) each:
   - users: `loadAdminUsersData(c.env.DB, new URL(c.req.raw.url).searchParams)` (verified
     :534 — takes searchParams) → `renderAdminUsersPage(p.ctx, data)` (:645).
   - orgs: `loadAdminOrgsData(c.env.DB, searchParams)` (:200) → `renderAdminOrgsPage`
     (:285).
   - repos: `loadAdminReposData(c.env.DB, p.ctx.viewer, searchParams)` (:325 — takes the
     UiContext Viewer) → `renderAdminReposPage` (:372).
4. Registrations beside the admin block (:9620-9626): `uiRouter.get("/-/admin/users", …)`
   ×3. Top-level static literals; nothing dynamic shadows them.

### 1.11 milestone-detail.tsx — NOT A MOUNT ITEM (verify-only)

Already mounted end-to-end at HEAD by ca4eb58: `MilestoneDetailRoute`/`MilestoneEditRoute`
unions (:1796-1813), parse claims (:3137-3152), three handlers (:9334-9390), three
registrations (:9939-9941). Commit 9468587 added only the supplementary matrix test. The
window does NOTHING for it beyond running its suites. (The mission list carried it stale;
its module header indeed has no HANDOFF NOTE — because it never needed one.)

---

## 2. The strip/nav folds (consolidated)

All folds are pages/*-owned files; index.ts touches only its own import list.

| # | File | Op |
| --- | --- | --- |
| F1 | pages/user-profile.tsx `ProfileTabs` (:404) | + Stars anchor (inactive here), props `starsCount`, locale `starred`; then + watching anchor after it (`EyeIcon` import from user-watching-tab, locale `watched`) |
| F2 | pages/user-profile.tsx `ProfileAvatarCard` (:339) | follower/following counts → the two tab anchors (§1.4.3) |
| F3 | pages/activity-feeds.tsx `OverviewTabs` (:741) | + Stars anchor, + watching anchor (own locale keys) |
| F4 | pages/user-follow-tabs.tsx `OverviewTabs` (:340) | + Stars anchor (reuse `userProfileLocale.starred` — the module imports it), + watching anchor |
| F5 | components/settings-nav.tsx | `UserSettingsNavTab` += `"account" \| "notifications"` (:131); TWO items inserted between Profile and Appearance (navbar.tmpl:7-11 and :12-16 positions — account first); `settingsNavLocale` += `account: "Account"`, `notifications: "Notifications"` |
| F6 | pages/user-settings-account.tsx (:568) + pages/user-settings-notifications.tsx (:307) | DELETE the module-local `AccountSettingsNav` / `UserSettingsNotificationsNav`; call sites swap to `<UserSettingsNavbar active="account" />` / `active="notifications"` (the wave-114 consolidation convention; settings-nav.tsx's swap list entries 14/15) |
| F7 | The admin family nav fold | ONE shared navbar across dashboard/monitor/users/orgs/repos: keep `AdminFamilyNav` (admin-users.tsx:291 — already the fullest: Maintenance + Identity & Access + Assets + Monitoring) as the base, widen `AdminFamilyNavActive` (:263) to cover `"dashboard"` + the four monitor pages (or take `active: string`), DELETE `AdminDashboardNav` (admin-dashboard.tsx:252) and `AdminMonitorNav` (admin-monitor.tsx:247), swap `AdminDashboardShell` (:285) and the monitor shell (:287) to the shared nav. Details-open semantics per active page: upstream opens the group containing the active item (navbar.tmpl's per-group `PageIs*` conditions) — the shared nav computes `open` from `active` |
| F8 | scripts/gen-ui-icons.mjs (optional) | `ALLOWLIST` += `'octicon-eye',` → `pnpm gen:icons` → swap `EyeIcon` embeds |

Semantic note that MUST survive into the folds (repeats §1.5/§1.6 on purpose): **Stars is
the default header anchor (DisableStars defaults false → `{{if not .DisableStars}}` renders
Stars); Watching is the `{{else}}` DisableStars arm — by default it is direct-URL-only and
renders NOTHING active.** The strips ship BOTH anchors (collapsed-if documented in code);
no strip may render watching INSTEAD of stars, and no strip may mark either inactive-item
active. The only active items are: the page's own tab on its own page (stars page → Stars
active, watching page → watching active, follow-tabs page → NEITHER — upstream renders the
overview header with no active item for followers/following).

---

## 3. index.ts order-of-operations (the one window)

Single-pass order that respects every discovered constraint:

1. Interfaces + union extensions (§1.1.1, §1.2.1, §1.3.1, §1.7.1, §1.8.1, §1.9.1, §1.10.1)
   — one edit at the union tail (:2386) plus the in-place family-union edits.
2. Parse claims (§1.1.2, §1.2.2, §1.3.2, §1.7.2, §1.8.2, §1.9.2, §1.10.2) — the wiki-raw
   claim MUST land in the early block (:2919) in the same pass as (or before) the catch-all
   comment update (:3169); nothing else is order-sensitive (all disjoint literals), but
   claims MUST exist before registrations go live or the dispatcher's `handlesUiRoute`
   consult (:3567 = `parseUiRoute !== null`) hands the paths to the engine (the dead-route
   class, three fixes this session).
3. Handlers (§1.1.4, §1.2.4, §1.3.3, §1.7.3, §1.8.3, §1.9.3, §1.10.3) + ownerHomePage's
   three tab arms (§1.4-1.6) + module imports.
4. Registrations (§1.1.3, §1.2.3, §1.3.3, §1.7.4, §1.8.4, §1.9.4, §1.10.4) — wiki-raw's
   line BEFORE the `wiki/*` pair (:10079-10080); everything else appends beside its family
   block.
5. The folds (§2) — pages/* + components/*, independent of 1-4 (can land in the same
   commit or a following one; the module tests demand F5/F6 and F1/F3/F4 in the window).
6. Test flips (§4) + goldens regenerate + new route matrices.

---

## 4. Test verification list (suites with inert-posture pins that MUST flip)

Concrete pins found by grep; each becomes a window op:

| Suite:line | Current pin | Flips to |
| --- | --- | --- |
| __tests__/pages-wave12.test.ts:189 | `expect(parseUiRoute("/user/settings/account")).toBeNull();` | the account GET family claim (and add the three POST claims) |
| __tests__/pages-wave25.test.ts:240 | `expect(parseUiRoute("/wave25-owner/labeled/tags.rss")).toBeNull();` | `toMatchObject({ family: "tags-feed-rss" })` (add the .atom arm) |
| pages/aux-fragments.matrix.test.tsx:541-542 | list/detail `parseUiRoute(...)` → `toBeNull()` ("No snapshot store" comment) | the two families claim (comment updates: the snapshot store landed, cced424) |
| pages/wiki.matrix.test.tsx:543-550 | `/wiki/raw/Home.md` → **303 `?action=_pages`** ("the byte arm stays unimplemented") | the byte arm: 200 raw bytes (existing page) / 404 shell (missing); keep a bare `/wiki/raw` → 303 pin |
| pages/admin-dashboard.test.tsx:195-208 | nav: `not.toContain('href="/-/admin/users"')` + `not.toContain('href="/-/admin/repos"')` ("nothing unlanded") | F7's shared navbar carries them → flip to `toContain` + assert the new groups (Identity & Access, Assets); the `self_check`/`config`/`notices` dead pins stay |
| components/settings-nav.test.tsx:93-94 | account + notifications hrefs pinned DEAD (`not.toContain`) | they render → flip; the USER_HREF_ORDER test (:89-91) grows the two items between Profile and Appearance |
| __tests__/goldens/user-profile.html (+ a11y.test.ts:61 consumer; pages-wave7.test.ts:271-277 pin) | golden carries the 2-anchor strip (8196440's shape) + plain-text counts | REGENERATES after F1+F2 (strip grows Stars + watching; counts become anchors) — one regeneration AFTER all folds, not one per fold |
| __tests__/pages-wave7.test.ts:236 | `toContain("0 followers")` | stays GREEN (the anchor wraps the same text) — verify, don't edit |
| pages/user-profile.matrix.test.ts (:261-331) | activity-arm pins: strip `toContain`s only | stay GREEN; ADD arms: `/upgal?tab=stars` / `?tab=watching` / `?tab=followers` / `?tab=following` render their pages, org+tab still org home |
| pages/admin-users.matrix.test.tsx:306-313 | module-direct AdminFamilyNav DOM pins | stay GREEN (nav fold keeps the same DOM; only the component's home moves) |
| pages/admin-monitor.test.tsx:448 | renders `<AdminMonitorNav active="stats" />` | swap to the shared nav (`active` mapping per F7); the item DOM is unchanged |
| pages/user-settings-account.test.tsx / user-settings-notifications.test.tsx | module-direct; wiring contracts pin constants only (notifications:360-367) | stay GREEN; the DEFERRED route matrices now land: anonymous 303s, saved 303 targets, invalid re-renders, guard-first cross-origin 403, nav-swap ("renders exactly once, marked active") |
| pages/releases-feed-xml.smoke.test.ts / tags-feed-xml.smoke.test.ts / wiki-raw.smoke.test.ts / issue-content-fragments.smoke.test.ts | module-direct byte/loader suites | stay GREEN; each gains (or the window adds) a route-level arm through the mounted router |
| pages/user-stars-tab.test.tsx / user-watching-tab.test.tsx / user-follow-tabs.test.tsx | module-direct | stay GREEN; the window adds the three/four dispatch arms to the user-profile matrix (above) |

New test surface the window should land (the modules defer it explicitly): one route-matrix
pass over the mounted families — feeds (content-type + gate matrix: releases-disabled repo
404s releases.rss but SERVES tags.rss; empty repo 404s both), wiki-raw (hasWiki off → 404;
bare `/wiki/raw` → 303), content-history list/detail (JSON 404 on foreign history id —
assert the JSON body, not the shell), admin trio (anonymous 303, non-admin 404), settings
pairs (the per-form error routing).

Housekeeping: docs/compat/ui-parity-survey.md row :549 (`/-/admin/*` — users/orgs/repos
PARTIAL→listed) and the `/user/settings/{…}` row (:546 — account + notifications land;
repos remains the absent tab).

---

## 5. Findings against HEAD (stale anchors fine; wrong = blocker)

**Blockers: none. Collisions: none.** Every recipe's parse claim is a disjoint literal or
an extend-in-place union; no two recipes share a registration slot; the only ordering
constraints (wiki-raw before the wiki wildcard; claims before registrations; admin
literals before any future dynamic arm) are honored by §3's order.

### 5.1 Mission-list correction

milestone-detail.tsx is NOT unmounted — fully mounted at HEAD (ca4eb58; registrations at
:9939-9941). Treat as verify-only. Its module header indeed carries no HANDOFF NOTE.

### 5.2 Stale anchors (updated in this plan, harmless)

- The recipes cite `ui/index.ts:9716-9717` for the user-feed registration — now :9731;
  `1543-1561` (ReleaseDownloadRoute) → :1555; `2057-2065` (WikiRoute) → :2059; `2386`
  (union tail) → exactly :2386 (still true); `2919-2933` → exactly :2919-2933; `3165-3177`
  → exactly :3165-3177; `3254` → exactly :3254; `3370` → exactly :3370; `2562-2572` →
  exactly :2562-2572; `6247-6256` → exactly :6247-6256; `7509-7547` → :7523-7549;
  `7624-7648` → :7624+; `7865-7870` → :7878-7881; `10075-10076`/`10079-10080` → exact.
- SPEC issue-content-history.md §6 cites :2976-2982 / :4550-4560 — now :2980-3004 /
  :4554-4566; and its `loadContentHistoryDetailFragment(db, …)` wording is wrong about the
  FIRST PARAMETER ONLY — the export takes `env` (issue-content-fragments.ts:699). Worth a
  one-line SPEC errata note in the window's docs batch.

### 5.3 Recipe gaps the window closes (not blockers — decisions recorded here)

1. user-settings-account's handoff names NO family literals — this plan fixes the four
   (`user-settings-account`, `-email`, `-email-delete`, `-delete`; §1.7) so the window
   does not invent them twice.
2. The releases/tags twins each ask for the union tail "index.ts:2327/2386" separately —
   fold BOTH interface unions into one edit at :2386 to avoid adjacent-line edit conflicts.
3. The avatar-card diff: landed markup has no person glyph; upstream's followers anchor
   embeds one (`octicon-person` 18px, allowlisted). This plan recommends parity-exact
   WITH the glyph; the plain wrap also passes the recipe (§1.4.3). Golden re-shapes either
   way.
4. The AdminFamilyNav fold (F7) requires the details-`open` computation to move from
   per-copy hardcoding to active-derived — admin-dashboard.test.tsx:195's title ("Maintenance
   open…") survives only because the dashboard IS a Maintenance page; the monitor page's
   test (:448) asserts via component render and needs the swap.

### 5.4 Concurrent-edit caution for the window

HEAD moved twice during this verification (sibling waves cf62b79…9468587 landed
mid-read; the working tree is clean at ed45502). The window MUST re-grep its anchors
(`§0` table) immediately before editing index.ts, and commit via pathspec only
(AGENTS.md commit policy) — sibling waves are still landing around it.

---

## 6. Operation count

- index.ts: 7 union/extension edits, 7 parse-claim edits, ~17 handlers, 7 registration
  edits, 3 ownerHomePage arms + imports ≈ 41 ops
- Strip/nav folds: F1-F8 ≈ 8 ops (F6 = 2 deletions + 2 swaps, F7 = 1 shared nav + 2
  deletions + 2 shell swaps)
- Test flips/additions: 7 flip ops + 1 golden regen + deferred route matrices ≈ 10 ops
- Docs: survey rows x2 + SPEC §6 errata line ≈ 3 ops

Total ≈ 62 discrete operations across the window, every one anchored to a verified
current-line location above.
