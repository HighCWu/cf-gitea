# SPEC-0007: Organizations & Teams (org storage model, membership, tier-1 org endpoints)

Status: **draft** — pending orchestrator review. Date: 2026-10-24.
Implements the organization half of SPEC-0004 category (a) for tier 1, the org-side
grant needed by SPEC-0003 §2.4 push-create row 19 (`CanCreateOrgRepo`), and the
`users.visibility`/owner-model commitments SPEC-0003 §2.5.6 relies on. References:
`specs/0002-auth.md` (users/tokens/scope grammar), `specs/0003-repo-lifecycle-git-http.md`
(ACL matrix, repo redirects, transfer), `specs/0004-api-v1-core.md` (tiering; §2.4 table
format reused in §2.2 below), `specs/0005-issues-prs-webhooks.md` §3.2 (org labels
`repo_id=0, org_id>0` — reads `users.id` as the org id, decided here).
Upstream findings are cited against the vendored submodule pin
`fc4936884584` (`v29.0.0-dev-208`, `git describe` in `gitea/`); upstream org models live
in `gitea/models/organization/` (note: not `models/org/`).

## 1. Problem and scope

Tier 1 exposes exactly three organization paths (SPEC-0004 §2.3, appendix A):
`GET /user/orgs`, `GET /orgs/{org}/repos`, `POST /orgs/{org}/repos`. Behind them sits a
storage decision that touches every owner-scoped surface already specced: git-HTTP repo
resolution (SPEC-0003 §2.1 step 4), push-create (§2.4 rows 19–20), transfer (§2.5.4),
org labels (SPEC-0005 §3.2), and the `users.visibility` input of the visibility model
(SPEC-0003 §2.5.6) that SPEC-0002's schema has not yet defined. This SPEC fixes the
organization storage model before any of those implementations meet an org in the wild.

In scope:

- **The org-storage decision**: org-as-user-table-row (upstream trick) vs a separate
  `orgs` table — decided with justification (§3.1).
- D1 schema: `users` table amendments (type, visibility, org profile columns),
  `org_members`, `user_redirects` (§3.2–3.4).
- Org membership minimal model and the org-level repo-create grant backing
  SPEC-0003 row 19; teams **deferred with a documented stub** (§3.5).
- Tier-1 endpoint mapping in the SPEC-0004 §2.4 format (§2.2).
- Org lifecycle for tier 1: row shape at create, rename + namespace redirects,
  visibility flips, deletion/last-owner guards (§2.4, §4).
- Edge cases: shared-namespace collisions, org deletion with repos, membership states,
  transfer integration constraint (§4).

Out of scope (tier 2 / later SPECs): the org CRUD API bodies (`POST /orgs`,
`GET/PATCH/DELETE /orgs/{org}`, `POST /orgs/{org}/rename` — SPEC-0004 appendix A marks
them T2; the *row shape* they will write is defined here), team CRUD and team-scoped
permissions (`/orgs/{org}/teams…`, `/teams/{id}…`, `/user/teams`), org labels
(SPEC-0005 §3.2 already owns them), org hooks/avatars-as-upload/blocks (T2), admin org
APIs (T3), `DELETE /orgs/{org}/repos` (delete-all-org-repos, excluded per SPEC-0004
§2.4), org projects (T3).

## 2. API surface, with upstream behavior notes

### 2.1 Upstream model (verified in source)

**Org-as-user row.** Upstream has no `organizations` table. `Organization` is a Go type
alias over `user_model.User` whose `TableName()` returns `"user"`
(`gitea/models/organization/org.go:76–87`); `CreateOrganization` inserts a `user` row
with `Type = UserTypeOrganization` (`org.go:305–333`). The `UserType` enum:
individual=0, organization=1, plus reserved/bot/remote variants
(`gitea/models/user/user.go:48–67`). Org lookups filter `lower_name = ? AND type = 1`
(`GetOrgByName`, `org.go:400–413`); user-directory lookups do **not** filter type
(`GetUserByName`, `user.go:1131–1134`) — that asymmetry is why a repo URL may point at
an org while `/orgs/{name}` may not resolve to a plain user. Uniqueness is one index on
the shared table: `IsUserExist` checks `user.lower_name` regardless of type
(`user.go:546–555`), so **a username and an org slug can never collide** — they are rows
in the same table.

**Org profile fields live on the user row**: `full_name`, `description`, `website`,
`location`, `email`, `avatar`/`avatar_email`/`use_custom_avatar`,
`repo_admin_change_team_access`, `num_members`, `num_teams`, `visibility`
(`user.go:99–165`). These are shared with individual users — the API `User` model
exposes `description`, `website`, `location`, `visibility` too, and the API
`Organization` model (`gitea/modules/structs/org.go:9–25`) is a re-projection of the
same row: `id, name, full_name, email, avatar_url, description, website, location,
visibility, repo_admin_change_team_access, username` (deprecated alias of `name`;
serializer `services/convert/convert.go:928–943`). Avatar URL is derived
(`AvatarLink`), never a stored URL; new orgs get a generated identicon
(`GenerateRandomAvatar`, `org.go:342–344`).

**Org creation transaction** (`CreateOrganization`, `org.go:305–398`): validate
`IsUsableUsername` + `IsUserExist` (shared namespace), insert the user row
(`NumTeams = 1`, `NumMembers = 1`), delete any `user_redirect` squatting on the name
(`:335–337`), insert `OrgUser{creator, is_public: DefaultOrgMemberVisible}`, and create
exactly one team — **Owners** (`lower_name='owners'`, `AccessMode=owner`,
`IncludesAllRepositories=true`, `CanCreateOrgRepo=true`, visibility limited) — plus its
`TeamUser` row for the creator and one `TeamUnit` row per unit type (`:355–395`). The
API handler (`routers/api/v1/org/org.go:259–284`) defaults `visibility` to public when
the form omits it, and 422s on name errors / 403s `not allowed to create org` when the
doer may not create orgs (`CanCreateOrganization`, `user.go:300–302`: admin or
`AllowCreateOrganization && !DisableRegularOrgCreation`).

**Team permission model** (all upstream, summarized for the deferral decision): a
`Team` row carries `authorize` (0 none / 1 read / 2 write / 3 admin / 4 owner,
`gitea/models/perm/access_mode.go:17–22`), `includes_all_repositories`,
`can_create_org_repo`, and its own visibility
(`gitea/models/organization/team.go:76–96`). Per-unit overrides live in `team_unit`
(`team_unit.go:15–21`); the effective unit permission is `max(team.authorize,
unit.access_mode)` capped by the unit's max (`team.go:204–219`). Team↔repo and
team↔user are plain join tables (`team_repo.go:17–22`, `team_user.go:16–21`).

**`CanCreateOrgRepo`** — the grant SPEC-0003 row 19 needs — is a single EXISTS query:
a team joined through `team_user` where `can_create_org_repo = true OR authorize = 4`
(`gitea/models/organization/org_user.go:98–106`). Note the org-owner fast path:
`GetUsersWhoCanCreateOrgRepo` uses the same disjunction (`org.go:428–437`). The
API-side guard `prepareDoerCreateRepoInOrg` additionally lets site admins bypass
(`routers/api/v1/repo/fork.go:87–110`), and push-create applies the identical rule
(`services/repository/repository.go:83–99`).

**Org visibility.** `users.visibility` ∈ public=0 / limited=1 / private=2
(`gitea/modules/structs/visible_type.go`, encoding confirmed by the comment at
`org_list.go:70–71`). The canonical predicate is `ownerVisibilitySatisfiesDoer`
(`org.go:439–455`): anonymous ⇒ public only; site admin or self ⇒ always; public ⇒
anyone (unless require-sign-in-view); limited ⇒ any non-restricted authenticated
principal; private ⇒ members only (plus admin). `HasOrgOrUserVisible` adds
membership as an override (`org.go:457–461`). Token interaction: a `public-only` token
is downgraded to anonymous-equivalent visibility (`DoerCanViewPrivate`,
`gitea/models/user/user_extdata.go:112–115`, cited in SPEC-0002 §4.1), and org listing
further requires `is_public` membership in that case (`org_list.go:57–63`).

**Membership states.** At this pin `OrgUser` is exactly `{ID, UID, OrgID, IsPublic}`
(`org_user.go:26–31`; fixtures `models/fixtures/org_user.yml` confirm the four
columns). The historical two-factor-enforcement column on org membership **no longer
exists** — nothing in the org path consults 2FA — so there is nothing beyond
`is_public` to keep. `is_public` gates public member listings
(`GetOrgUsersByOrgID` filters `is_public = true` for under-privileged doers,
`org.go:473–495`; `FindOrgMembersOpts.PublicOnly`, `org.go:180–182`). `AddOrgUser`
maintains the `num_members` counter (`org.go:515–542`).

**Rename.** `RenameUser` (`gitea/services/user/user.go:36–110`) handles users *and*
orgs (`POST /orgs/{org}/rename` calls it directly, `routers/api/v1/org/org.go:342–368`):
validate `IsUsableUsername`, case-fold collision check via `IsUserExist`, update
`name`+`lower_name` on the user row, insert a `user_redirect` row old→id
(`models/user/redirect.go:56–73`, which first deletes any redirect at the old *and*
new names), and rename the on-disk storage directory. Repos are untouched: they
reference `owner_id`, and `repositories.owner_name` (upstream's denormalized copy) is
rewritten. Case-only renames skip the redirect (`user.go:48–59`). Old URLs are caught
by `LookupUserRedirect` and answered with a **307 that path-rewrites the owner
segment** — `RedirectToUser` replaces the first occurrence of the old name in the
request path and keeps the query string (`services/context/context_response.go:28–56`),
so `/oldorg/repo.git/info/refs` → `307 /neworg/repo.git/info/refs`; it 404s instead if
the renamed org's visibility doesn't satisfy the doer (`:40–47`). The API org group
performs the same redirect for `/orgs/{oldorg}` (`routers/api/v1/api.go:628–631`).

**Deletion.** `DeleteOrganization` refuses while the org owns repos:
`ErrUserOwnRepos` "user still has ownership of repositories [uid: N]"
(`gitea/models/repo/repo.go:848–862`); only with `purge=true` (web UI flow) are repos
deleted first (`gitea/services/org/org.go:58–104`). The API `DELETE /orgs/{org}`
passes `purge=false` and maps *every* error through `APIErrorInternal` — a 500 whose
`message` is **blanked in prod for non-admin callers** (`routers/api/v1/org/org.go:423–446`
+ `services/context/api.go:122–134`) — while the swagger declares only 204/404.
Cascade deletes teams, org_user, team_user, team_unit, team_invite rows and the user
row (`org.go:30–55`); notably it does *not* delete `user_redirect` rows.

**Last-owner guard.** Removing the last Owners-team member is refused with
`ErrLastOrgOwner` (`org.go:44–57`), raised in `RemoveOrgUser` (owner team with
`NumMembers == 1`, `gitea/services/org/user.go:36–52`) and `removeTeamMember`
(`gitea/services/org/team.go:313–321`). The API maps it through `APIErrorInternal`
→ **500**, not a 4xx (`routers/api/v1/org/member.go:338–343`).

### 2.2 Tier-1 endpoint mapping (SPEC-0004 §2.4 format)

Source legend: **D1** = Drizzle tables only; **both** = D1 + RepoDO/R2 via the
SPEC-0001 storage interface (engine commit-builder for `auto_init`, SPEC-0004 §3.4).
Scope column: SPEC-0002 token categories enforced when a token is presented. Cache:
**none** (D1 per request). Error bodies `{message, url}` per SPEC-0004 §2.5.

| Path (tier-1 methods) | Source | Scope (SPEC-0002) | Cache | Upstream gotchas visible in the contract/source |
|---|---|---|---|---|
| `GET /user/orgs` | D1 (`org_members ⨝ users` where `type='org'`) | `read:user` **and** `read:organization` — upstream wires both categories (`api.go:1718`; SPEC-0004 §2.4 row) | none | `reqToken` ⇒ anonymous gets 401 (the swagger-declared 404 is unreachable). Items are full `Organization` objects (11 fields, §2.1), ordered `lower_name ASC` (`org_list.go:75–77`), `Link` + `X-Total-Count` headers (`routers/api/v1/org/org.go:38–59`). **Self-list semantics**: doer == subject ⇒ `IncludeVisibility = private` (`DoerViewOtherVisibility`, `org_list.go:79–90`), which skips the `is_public` membership filter (`org_list.go:57–71`) — a regular user sees *all* their memberships incl. non-public ones in limited/private orgs; an admin sees the same (no admin expansion on this path; the admin-vs-user difference only exists on tier-2 `GET /users/{username}/orgs`). A `public-only` token degrades to public visibility **and** public-flagged membership only (§2.1). |
| `GET /orgs/{org}/repos` | D1 (repo registry by `owner_id`) | `read:organization` (group middleware; anonymous allowed — no `reqToken` on this GET, `api.go:1733`) | none | Handler is `user.ListOrgRepos` (`routers/api/v1/user/repo.go:139–166`) — same code path as `GET /users/{username}/repos` with `private = ctx.IsSigned`: signed-in callers fetch private rows too, then a per-repo permission filter keeps only repos where the doer holds *any* unit access (`user/repo.go:19–54`); anonymous keeps `is_private = false` only. **Org-visibility quirk (mirror, see §4.7)**: the API org group checks only the public-only-token gate (`DoerTokenAllowsOwner`, `api.go:660–663`), not limited/private visibility — an anonymous caller receives `200` + the public repos of a *limited* or *private* org, unlike git HTTP (SPEC-0003 §2.4 row 2) and unlike `GET /orgs/{org}` whose handler 404s via `HasOrgOrUserVisible` (`routers/api/v1/org/org.go:324–327`). Org missing ⇒ JSON 404 `{"message":"not found",…}`; org renamed ⇒ **307** path-preserving owner rewrite (§2.1) *before* any listing. Pagination: `page`/`limit` + `Link`/`X-Total-Count`. |
| `POST /orgs/{org}/repos` | both | `write:organization` **and** `write:repository` — the group requires Organization, the route adds Repository (`api.go:1733–1734`), plus `rejectPublicOnly` | n/a | 201 + full `Repository` (owner-permission block `AccessModeOwner`). Guard order: org missing → 404; org invisible (`HasOrgOrUserVisible`) → 404; **repo-create grant** missing → 403 `"User is not allowed to create repositories in this organization."` (`fork.go:97–108`; admins bypass); duplicate name → 409 `"The repository with the same name already exists."` (`routers/api/v1/repo/repo.go:257–258`); reserved/invalid name → 422 with `err.Error()` (`repo.go:259–262`). `auto_init` runs the initial commit through the engine (SPEC-0004 §3.4 commit-builder); `ForcePrivate`/`DefaultPushCreatePrivate` flags apply as in `CreateUserRepo` (`repo.go:242–255`). This endpoint and git push-create (SPEC-0003 row 19) share the same grant predicate (§3.4). |

Tier-2 preview (row shape decided now, bodies deferred): `GET /orgs/{org}` returns the
`Organization` object of §2.1 with `email` blanked for anonymous callers
(`routers/api/v1/org/org.go:329–339`) and 404 for missing **or** invisible orgs
(handler-level `HasOrgOrUserVisible` — stricter than the repos listing, §2.2).
`PATCH` takes `EditOrgOption` (all optional: `full_name, email, description, website,
location, visibility, repo_admin_change_team_access`,
`gitea/modules/structs/org.go:63–78`); `DELETE` carries the repos-owned-500 quirk
(§2.1, §4.2); `POST /orgs/{org}/rename` takes `{new_name}` and returns **204**
(`org.go:342–368`).

### 2.3 Response schema notes

- `Organization` (11 props, swagger `#/definitions/Organization`): `avatar_url`,
  `description`, `email`, `full_name`, `id`, `location`, `name`,
  `repo_admin_change_team_access`, `username` (deprecated), `visibility`
  (`"public"|"limited"|"private"`), `website`. The swagger `User` model shares
  `description`, `website`, `location`, `visibility` — same columns, different
  projection; one storage row feeds both.
- `GET /user/orgs` → `OrganizationList` (array); `GET /orgs/{org}/repos` →
  `RepositoryList` (array of the 71-field `Repository`, SPEC-0004 §2.5);
  `POST /orgs/{org}/repos` → `Repository` at 201.

## 3. Data model

### 3.1 Decision: org-as-user-table-row (upstream trick), not a separate `orgs` table

**Decided: reuse the `users` table with a `type` column**, exactly as upstream does
(§2.1). Justification:

1. **Shared namespace, atomic by construction.** Usernames and org slugs share one
   uniqueness domain upstream (`IsUserExist` is type-blind, `user.go:546–555`). With a
   separate `orgs` table, D1/SQLite cannot express a uniqueness constraint spanning two
   tables — every create would need a check-then-insert that races (two requests
   creating user `acme` and org `acme` concurrently could both win their local checks).
   The shared table turns the whole question into `UNIQUE(users.username_lower)`.
   This alone is close to decisive for a forge whose entire URL space is
   `/{owner}/{repo}`.
2. **Owner lookups stay single-table.** SPEC-0003 §2.1 step 4 resolves
   `repositories.owner_id → users` and `/{owner}/…` by name. With the shared table this
   is one indexed lookup and no type filter (mirroring `GetUserByName`,
   `user.go:1131–1134`). A separate table would force a two-pass or `UNION` resolution
   on every git-HTTP request and every repo API call (SQLite has no `FULL OUTER JOIN`,
   so it would be two queries or a subquery union).
3. **One redirect table for the namespace.** Org rename inserts the same
   `user_redirect` row kind as user rename (§2.1); `CreateOrganization` even
   pre-deletes redirects (`org.go:335–337`). With separate tables we would need a
   second redirect table or a discriminator column.
4. **API surface overlap.** The `Organization` response is a projection of user-row
   columns (§2.3); `GET /users/{username}` vs `GET /orgs/{org}` differ by `type`, and
   org labels (SPEC-0005) already key on `users.id`.
5. **Upstream parity** keeps the compat story simple: counters (`num_members`),
   visibility, and reserved-name rules behave identically because they are the same
   code paths.

Costs, accepted: the `users` row carries org-only columns (nullable/defaulted; the
same trade upstream makes — `passwd`-family columns are meaningless for orgs there
too), and a `WHERE type='org'` filter must appear on org-scoped queries (mirroring
`GetOrgByName`).

Rejected alternative — **separate `orgs` table**: cleaner columns, but breaks (1)–(4)
above; a trigger-less D1 cannot enforce cross-table name uniqueness, and the
SPEC-0003 hot path (owner resolution on every git request) doubles its metadata
lookups. Not worth it.

### 3.2 `users` table amendments (this SPEC owns the delta to SPEC-0002 §3)

```ts
// SPEC-0002 §3 users table gains:
export const users = sqliteTable('users', {
  // ...existing columns (id, username, usernameLower, email, displayName,
  //     isAdmin, status, createdAt) ...

  /** 'user' | 'org' — upstream UserType 0/1 (gitea/models/user/user.go:48–67).
   *  Reserved int variants (2–5) have no cf-gitea equivalent yet. */
  type: text('type', { enum: ['user', 'org'] }).notNull().default('user'),

  /** 0 public | 1 limited | 2 private — upstream `Visibility`
   *  (user.go:161; comment encoding org_list.go:70–71). INTEGER, not text:
   *  the listing predicate is a range compare (`visibility <= :max`,
   *  org_list.go:71) and alphabetical text order would scramble the ladder.
   *  Fulfills SPEC-0003 §2.5.6's `users.visibility` dependency. */
  visibility: integer('visibility').notNull().default(0), // PUBLIC=0

  // Org/user profile (upstream user.go:99–165); null for unused profile fields.
  fullName: text('full_name'),
  description: text('description'),
  website: text('website'),
  location: text('location'),
  /** Avatar fallback address (upstream AvatarEmail) + custom-avatar switch. */
  avatarEmail: text('avatar_email'),
  useCustomAvatar: integer('use_custom_avatar', { mode: 'boolean' })
    .notNull().default(false),

  /** Maintained member counter (upstream NumMembers, org.go:330–331/537). */
  numMembers: integer('num_members').notNull().default(0),

  /** Org-only flag, honored when teams land (upstream user.go:165). Stored now
   *  so the tier-2 PATCH /orgs/{org} body has a home. */
  repoAdminChangeTeamAccess: integer('repo_admin_change_team_access',
    { mode: 'boolean' }).notNull().default(false),
}, (t) => [
  uniqueIndex('users_username_lower_uq').on(t.usernameLower),
  // type-aware partial indexes keep org lookups and user listings cheap
  index('users_type_idx').on(t.type),
]);
```

Not modeled (with upstream citations): `max_repo_creation` (repo-count quotas, unused
at `-1` default, `user.go:127–129`), `num_teams` (meaningless until teams land;
revisit with §3.5), `num_repos` (upstream maintains it, but nothing in our tier-1
surface reads it — listings COUNT), avatar binary storage (divergence: no identicon
generation at create; `avatar_url` derives from `avatar_email` hash, falling back to
the username hash when unset — documented in §4.6), password/2FA/language/theme
columns (orgs never sign in; users don't have passwords yet per SPEC-0002 open
questions).

### 3.3 `org_members`

Upstream splits membership into `org_user` (membership + `is_public`) and, implicitly,
owner-ness via the Owners team (`team_user` ⨝ `team`). Tier 1 has no teams (§3.5), so
the two facts collapse into one row:

```ts
export const orgMembers = sqliteTable('org_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orgId: integer('org_id').notNull().references(() => users.id,
    { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id,
    { onDelete: 'cascade' }),
  /** Public membership flag — upstream OrgUser.IsPublic
   *  (gitea/models/organization/org_user.go:26–31). Gates public member
   *  listings (org.go:473–495). */
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  /** 'owner' ⟺ membership in the upstream synthetic Owners team at tier 1
   *  (CreateOrganization inserts exactly one team, org.go:355–368). */
  role: text('role', { enum: ['owner', 'member'] }).notNull().default('member'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [
  uniqueIndex('org_members_org_user_uq').on(t.orgId, t.userId),
  index('org_members_user_idx').on(t.userId),
]);
```

Membership test = row exists (`IsOrganizationMember`, `org_user.go:80–86`); owner test
= `role='owner'` (`IsOrganizationOwner`/`IsUserOrgOwner`, `org_user.go:67–77` and
`org.go:89–92`, collapsed). `is_public` default follows upstream
`DefaultOrgMemberVisible` = false (`org.go:347–353`). `num_members` on the org row is
maintained in the same D1 batch as insert/delete (upstream `org.go:537`,
`services/org/user.go:59–61`).

### 3.4 Org-level repo-create grant (SPEC-0003 row 19)

```
canCreateOrgRepo(orgId, userId):
  tier 1:  org_members.role = 'owner'
  tier 2+ (teams): role='owner' OR EXISTS(team t
             JOIN team_members tm … WHERE t.org_id=? AND tm.user_id=?
             AND (t.can_create_org_repo OR t.authorize='owner'))
```

The tier-2 extension is the verbatim port of upstream's EXISTS query
(`org_user.go:98–106`). At tier 1 the role predicate is *exactly equivalent* to
upstream's reachable state space: a fresh org has one team (Owners,
`can_create_org_repo=true`) and the only way to hold `CanCreateOrgRepo` is to be in
it; no tier-1 API can create another team or add `can_create_org_repo` to one. Both
callers use the same service function: `POST /orgs/{org}/repos` (§2.2) and git
push-create (SPEC-0003 §2.4 row 19 ↔ `PushCreateRepo`,
`services/repository/repository.go:83–99`, admin bypass included).

### 3.5 Teams — deferred with a documented stub

**Tier-1 endpoints need no teams.** Evidence per endpoint: `GET /user/orgs` needs
`org_members` only (§2.2); `GET /orgs/{org}/repos` visibility-filters by repo privacy
plus any-unit-access — at tier 1 an org member's "any unit access" exists only via
ownership, i.e. `org_members.role` (a non-owner member with no teams has zero repo
access upstream too, since the Owners team is the only one); `POST /orgs/{org}/repos`
needs the §3.4 grant. The full upstream model — `team`
(`team.go:76–96`), `team_user` (`team_user.go:16–21`), `team_repo`
(`team_repo.go:17–22`), `team_unit` (`team_unit.go:15–21`), team invites
(`team_invite.go`) — lands with the tier-2 team API SPEC, which must also:
(a) backfill the synthetic Owners team for existing orgs (or keep the role→team
bridge), (b) extend `canCreateOrgRepo` per §3.4, (c) wire
`includes_all_repositories`/`team_repo` into the repo-permission service
(`GetDoerRepoPermission` family), and (d) honor `repo_admin_change_team_access`.
Until then the stub above is the single integration point.

### 3.6 `user_redirects` (namespace redirects, owned here)

```ts
export const userRedirects = sqliteTable('user_redirects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Case-folded old name; UNIQUE — one redirect per name, namespace-wide. */
  lowerName: text('lower_name').notNull(),
  redirectUserId: integer('redirect_user_id').notNull().references(() => users.id,
    { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('user_redirects_lower_uq').on(t.lowerName)]);
```

Port of upstream `user_redirect` (`models/user/redirect.go:33–46`). Distinct from
SPEC-0003's `repo_redirects` (keyed `(owner_id, lower_name)`): owner renames write
here, repo renames write there; both may fire for one URL chain (§4.4). Write rule
(`redirect.go:56–73`): on rename, delete any redirect at the old name, delete any at
the new name (the new name must resolve directly), insert old→id.

### 3.7 Integration commitments

- SPEC-0003 repo resolution (§2.1 step 4) is unchanged: owner rows live in `users`,
  looked up case-insensitively **without a type filter**; org-rename resolution adds
  one optional `user_redirects` lookup on miss (§4.4).
- SPEC-0005 org labels (`repo_id=0, org_id>0`) reference `users.id` rows with
  `type='org'`; org-label writes must verify the type (upstream's
  `label.RepoID != repo.ID && label.OrgID != owner` drop rule,
  `models/issues/issue_update.go:424–429`, assumes the org/user duality).
- Push-create rows 19–20 read §3.4's grant; SPEC-0003's `ENABLE_PUSH_CREATE_ORG`
  divergence (on by default) is unchanged.

## 4. Edge cases, limits, failure modes

| # | Case | Behavior |
|---|---|---|
| 4.1 | **Username/org slug collision** | Impossible by construction: one `users` table, `UNIQUE(username_lower)` covers both (§3.1; upstream `IsUserExist`, `user.go:546–555`). Reserved names apply to orgs exactly like users — org creation validates `IsUsableUsername` (`org.go:310–312`), port the reserved list (`user.go:622–660`: `api`, `org`, `user`, `repo`, `admin`-family paths, `ghost`, …) and patterns (`*.keys`, `*.gpg`, `*.rss`, `*.atom`, `*.png`, `user.go:665–666`). Upstream's own comment warns an org named `invite` breaks routing — the reserved list is load-bearing, do not trim it. Case-insensitive: `alice` the user blocks org `Alice` (`lower_name` unique). |
| 4.2 | **Org deletion with repos** | Tier 1 has no delete API; the rule is fixed now: refuse while `repositories` rows with `owner_id=org` exist. Upstream: `ErrUserOwnRepos` → `DELETE /orgs/{org}` → **500** with `message` blanked in prod for non-admins (§2.1; swagger declares only 204/404). cf-gitea mirrors (compat over beauty). Successful delete cascades `org_members`, `user_redirects` (improvement over upstream, which leaks redirect rows — harmless but stale), and the `users` row; repos are purged first per SPEC-0003 §2.5.5 (per-repo R2/DO cleanup is a repo operation, not an org one). |
| 4.3 | **Last-owner removal** | The service layer refuses any membership change that would leave an org with zero `role='owner'` rows, in the same D1 batch (conditional `UPDATE/DELETE … WHERE (SELECT COUNT(*) …) > 1` guard). This is upstream's `ErrLastOrgOwner` guard (`services/org/user.go:36–52`, `services/org/team.go:313–321`). When tier-2 member APIs land: upstream answers the API with **500** (`member.go:338–343`) — mirror it rather than inventing a 4xx. Org *deletion* is exempt (the whole org goes, §4.2). |
| 4.4 | **Org rename — repo URL consequences** | Repos are untouched: `owner_id` is stable, so SPEC-0003 `repo_redirects` (keyed by `owner_id`) stay valid and `storage_key` never changes (upstream must rename a directory, `services/user/user.go:100–107`; we do nothing). Old URLs resolve via `user_redirects`: `/oldorg/<anything>` → **307** to `/neworg/<anything>` (path+query preserved, `context_response.go:44–56`) before auth challenges — same ordering rationale as SPEC-0003 §2.5.3 (git clients must see redirects before 401s); visibility-checked (limited/private renamed org ⇒ 404, not redirect, for ineligible doers). If the repo was *also* renamed, the client follows once more through `repo_redirects` — two hops, both 307. New-name shadowing: creating an org on a name that is a live redirect deletes that redirect first (upstream `CreateOrganization`/`NewUserRedirect`, §2.1). Case-only rename: update `username` display case only, **no redirect row** (upstream `RenameUser` onlyCapitalization branch, `user.go:48–59`). |
| 4.5 | **Membership states** | Minimal by upstream evidence: `is_public` is the only flag that survives at the pin (§2.1 — the historical 2FA-enforcement column is gone; nothing consults 2FA in the org path). `role` is our Owners-team collapse (§3.3) and must be re-derived, not migrated, when teams land. `is_public=false` hides a member from public member listings only — it grants/denies *no* repo access. |
| 4.6 | **Avatar** | Divergence: no identicon generation at org create (upstream `GenerateRandomAvatar`, `org.go:342–344`). `avatar_url` in responses = upstream-style email-hash URL built from `avatar_email` (falls back to a username-derived hash); nobody fetches the referenced route until the avatar/`misc` surface exists (T2+). Clients only render the string. |
| 4.7 | **Limited/private org, anonymous repo listing** | Upstream quirk, **mirrored**: `GET /orgs/{org}/repos` anonymous on a limited org returns 200 + its public repos (no owner-visibility predicate in `GetUserRepositories` beyond the public-only-token cond, `models/repo/repo_list.go:774–779, 813–842`), while `GET /orgs/{org}` 404s and git HTTP 401-challenges (SPEC-0003 §2.4 row 2). The same inconsistency exists for private orgs with public repos. Documented as intentional parity; flagged in open questions for a later compat re-check. |
| 4.8 | **Visibility flip** | `UPDATE users SET visibility=?` only. Effects, by SPEC-0003 §2.4 rows: public→limited: anonymous public-repo fetch loses row 1 (401 challenge); signed-in non-restricted users keep access. →private: non-members additionally lose `GET /orgs/{org}` (404, §2.2 tier-2 preview) and any ungranted repo access (rows 8/9 404). Members and admins are unaffected at every step (`ownerVisibilitySatisfiesDoer` self/admin arms, `org.go:439–455`). `GET /user/orgs` visibility ceiling changes for *other*-viewers only (self-list ignores it, §2.2). No cache invalidation: API lists are D1-per-request; git HTTP re-checks per request (SPEC-0003 §2.5.6). Public-only-token callers additionally lose non-public-flagged memberships instantly (`org_list.go:57–71`). |
| 4.9 | **Repo transfer into an org** (integration constraint on SPEC-0003 §2.5.4) | Upstream requires the doer to hold repo-create rights on the target org for the accept path (same `CanCreateOrgRepo` family as push-create; SPEC-0003's `repo_transfer.new_owner_id` may reference an org row). At tier 1: accept into an org requires `role='owner'`; the "target teams later" note in SPEC-0003 §2.5.4 is satisfied by §3.5 (no team rows to write). Verify the exact upstream predicate when the transfer API is implemented. |
| 4.10 | **Renamed-org push-create / create races** | A push or `POST` to `/orgs/{oldorg}/…` meets the 307 before auth (§4.4), so push-create races apply only to current names — SPEC-0003 §4.1 semantics unchanged. The redirect insert/delete is part of the same D1 transaction as the rename; a crashed rename rolls back atomically (no upstream-style directory rollback needed, cf. `user.go:100–116`). |
| 4.11 | **`GET /orgs/{user}` (type mismatch)** | Org-scoped paths filter `type='org'` (`GetOrgByName`, `org.go:400–413`): `GET /orgs/{alice}` where `alice` is a *user* → 404 (JSON), never a user-shaped response. The asymmetry runs the other way too: API user-scoped paths do **not** type-filter — `UserAssignmentAPI` resolves any user row by name (`services/context/user.go:38–58`, `GetUserByName`), so `ctx.ContextUser` for `/users/{orgname}/…` is the org row (tier-2 user paths must decide behavior deliberately, not assume 404; `GetIndividualUserByName`, `user.go:1136–1138`, exists for the sign-in path only). Repo URLs (`/{owner}/{repo}`) do **not** filter (§3.7) — the same repo machinery serves both owner kinds. |
| 4.12 | **Limits** | Org/profile field caps come from `CreateOrgOption` bindings (`structs/org.go:44–61`): `username` ≤ 40, `full_name` ≤ 100, `email`/`description`/`website` ≤ 255, `location` ≤ 50 — enforce in the zod schemas when the T2 create body lands, and as column sanity checks now. `num_members` maintained; listings always paginate (default 30 / max 50, SPEC-0004 §2.5). |

## 5. Testing plan

Unit (vitest, pure modules):

- Visibility predicate: port `ownerVisibilitySatisfiesDoer` (`org.go:439–455`) as a
  truth table × {anon, ghost, admin, self, member, non-member, restricted, public-only
  token} × {public, limited, private}.
- `canCreateOrgRepo` predicate (§3.4): owner-role rows grant; plain members don't;
  admin bypass at the caller level, not in the predicate; the tier-2 team extension
  behind the same interface (compile-time test only until teams land).
- Username validation: reserved-name table and patterns from `user.go:622–666`
  (including `org`, `invite`-adjacent cases), case-folding, 40-char cap.
- Rename redirect rules (§3.6): old/new shadow deletion, case-only rename writes no
  redirect.

Worker tests (`@cloudflare/vitest-pool-workers`, real local D1 + engine):

- **`GET /user/orgs`**: memberships incl. non-public ones listed for self (the
  `org_list.go:57–71` filter-skip behavior); `public-only` token sees only
  public-flagged memberships in public orgs; no token → 401 `"token is required"`;
  missing both scope categories → 403 with `required=[user, organization]`
  (SPEC-0002 §2.4 grammar); ordering `lower_name ASC`; `Link`/`X-Total-Count`
  present; response body matched field-by-field against the 11-prop `Organization`
  model.
- **`GET /orgs/{org}/repos`**: anonymous × public/limited/private org (pinning the
  §4.7 quirk: 200 for all three, private repos omitted); signed non-member sees no
  private repos; owner-member sees them; missing org → 404 JSON; renamed org → 307
  with Location preserving the repo path + query; pagination clamps (30/50).
- **`POST /orgs/{org}/repos`**: 201 (+ `auto_init` produces a non-empty repo through
  the engine commit-builder); 403 byte-exact `"User is not allowed to create
  repositories in this organization."` for a non-owner member; admin bypass; 409
  byte-exact duplicate message; 404 for invisible org; both scope categories
  enforced individually (org-scope-only token → 403; repo-scope-only token → 403);
  `public-only` rejection per `rejectPublicOnly`.
- **Lifecycle**: create (row shape: `type='org'`, `num_members=1`, creator
  `role='owner'`, `is_public=false`); rename (redirect row, old org API URL 307, old
  repo URL 307 into the new namespace, `repo_redirects` untouched, case-only rename
  leaves no redirect); visibility flips (§4.8 matrix as table-driven assertions on
  `/orgs/{org}`-class checks, git-HTTP row 1↔2 transitions reused from SPEC-0003's
  harness); delete guard (org with a repo refuses; cascade empties `org_members` +
  `user_redirects`); last-owner guard (role demote/remove refused while it is the
  only owner).
- **Push-create integration** (extends SPEC-0003 §5 item 2): owner pushes to
  `/{org}/newrepo` → created (row 19); non-owner member → 404 (row 20, grant
  missing); 403 text only when org push-create is disabled (SPEC-0003 divergence
  flag).

Compat checks (black-box, ADR-0001 D4 oracle mode):

- Diff the three tier-1 paths' status codes + bodies against a real Gitea instance,
  seeded with org/user/repos; acceptable diff set = §4.6 (avatar) + §4.7 note (we
  mirror upstream, so the oracle must *reproduce* the quirk, not hide it).
- Rename-oracle: `POST /orgs/{org}/rename` is T2; test the storage behavior via the
  service layer only, and the 307 semantics via seeded redirect rows.

## Open questions (resolve at implementation / orchestrator review)

1. **Org creation path for tier 1**: no create API ships in tier 1 (SPEC-0004
   appendix: `POST /orgs` is T2). Default: the org service function is implemented +
   unit-tested now, exercised by worker tests via a seeding helper; humans create
   orgs when the T2 body lands. Confirm no earlier need (e.g. an admin CLI).
2. **§4.7 quirk re-check**: mirror now (compat), but verify against the oracle that
   current upstream hasn't added an owner-visibility guard to `ListOrgRepos` after
   this pin; if the re-pin (ADR D5) tightens it, adopt the tightened behavior and
   drop the quirk row.
3. **`num_members` maintained vs COUNT-on-read**: default maintained (upstream
   parity, one extra write per membership change); revisit if membership churn
   makes D1 write costs visible.
4. **Avatar URL shape**: email-hash fallback (§4.6) assumes clients don't require the
   URL to resolve during tier 1; if the vendored frontend fetches it eagerly, add a
   tiny `/avatar/{hash}` route early (misc, T2 candidate).
5. **`user_redirects` ownership**: table defined here because rename semantics are
   org+user namespace; SPEC-0003 consumes it for git-HTTP resolution. Confirm the
   migration ordering (this SPEC's migration may land before SPEC-0003's).
6. **Team-table backfill strategy when teams land** (§3.5): real `team` rows for the
   Owners team vs permanent role↔team bridge. Default: create real rows and make
   `role` a derived cache — decided in the teams SPEC.

## Milestones

M1 schema + migration (users amendments, org_members, user_redirects) · M2 org
service (create/rename/visibility/member guards + unit tests) · M3 tier-1 read paths
(`/user/orgs`, org repos listing) with pagination headers · M4 `POST
/orgs/{org}/repos` over the engine commit-builder + grant wiring into SPEC-0003
push-create · M5 compat/oracle run + SPEC-0003 §5 checklist extension.

**§3.5(c) as-built refresh (2026-10-25, d496ab8)**: repo-scoped READ visibility
resolves through `canViewRepositoryWithTeams` at every seam — the shared
repo-access resolver (~90 call sites in one point), the 15 route-file local
copies, repoGet/ByID, and the list SQL (`visibilityConditions` carries the
EXISTS twin of the grant, incl. the units_map json_each collapse — a list
never shows a repo the per-repo seam would 404). Anti-enumeration unchanged
(invisible ≡ missing, byte-identical). Known remaining: `listOrgRepos`
(orgs.ts) and the WRITE-grant team arms (isRepositoryAdmin/canWriteRepository
still collaborator-rows-only) — follow-up wave.

**§3.5(c) tail closed (2026-10-25, 5f6d798)**: `listOrgRepos` carries the
team-grant EXISTS twin (upstream parity verified — repo.go:41-45 +
repo_permission.go:483, no divergence); `isRepositoryAdmin`/
`canWriteRepository` gained the team arms through the ONE composition
(viewerTeamAccessMode → doerRepoAccessMode → repositoryPermissions) — grant,
git-HTTP gate, and rendered permissions cannot drift. Remaining known: the
UI render-gate forks (file-editor canWriteRepo / settings canAdminRepo read
collaboratorModeOf only — team members can POST but don't SEE the controls;
the service seam carries the grant underneath).
